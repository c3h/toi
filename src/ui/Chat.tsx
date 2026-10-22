import {
  ArrowDown,
  ArrowUp,
  Hash,
  RotateCcw,
  Square,
  Timer,
  X,
  Zap,
  Gauge,
  type LucideIcon,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import type { ProviderInfo, Toi } from '../app/toi';
import { messageFor, type AppErrorInfo } from '../domain/error';
import type { ConversationId } from '../domain/ids';
import { finalUsageOf, textOf, timingOf, type Message } from '../domain/message';
import { findModel, refFrom, type Effort, type Model } from '../domain/model';
import { CopyButton } from './CopyButton';
import { EffortPicker, effortLabel } from './EffortPicker';
import { ModelPicker } from './ModelPicker';
import { preloadMarkdown, Prose } from './Prose';
import { formatSeconds, formatTokens, lower } from './support';
import { useMessages } from './use-messages';
import { useReveal } from './use-reveal';

export type Notice =
  { kind: 'error'; error: AppErrorInfo } | { kind: 'truncated' } | { kind: 'not_saved' };

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface ChatHandle {
  focus(): void;
}

interface ChatProps {
  ref?: Ref<ChatHandle>;
  toi: Toi;
  provider: ProviderInfo;
  conversationId: ConversationId | null;
  /** Todos os Modelos da Chave, para nomear o de cada Mensagem. */
  models: Model[];
  /** Os que o seletor oferece. */
  modelOptions: Model[];
  model: Model | null;
  effort: Effort;
  running: boolean;
  notice: Notice | null;
  noticeAction: NoticeAction | null;
  onModelChange: (model: Model) => void;
  onEffortChange: (effort: Effort) => void;
  onManageModels: () => void;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onRetry: (message: Message) => void;
  onDismissNotice: () => void;
}

const NOTICE_TEXT: Record<Exclude<Notice['kind'], 'error'>, string> = {
  truncated: 'parte do meio da conversa ficou fora do contexto para caber no modelo.',
  not_saved: 'a resposta chegou, mas não foi salva no navegador.',
};

const modelName = (message: Message, models: Model[]): string | null => {
  if (!message.model) return null;
  const model = findModel(models, refFrom(message));
  return (model?.displayName ?? message.model).toLowerCase();
};

/** Uma medida do rodapé: curta à vista, por extenso no `title` e para leitor de tela. */
interface Stat {
  icon: LucideIcon;
  short: string;
  label: string;
}

/** Na ordem em que a resposta acontece: espera, ritmo, tamanho. */
const statsOf = (message: Message): Stat[] => {
  const usage = finalUsageOf(message);
  if (!usage) return [];

  const stats: Stat[] = [];
  const timing = timingOf(message);
  if (timing) {
    const wait = formatSeconds(timing.firstTokenMs);
    stats.push({ icon: Timer, short: wait, label: `${wait} até o texto aparecer` });

    if (timing.tokensPerSecond !== null) {
      const rate = formatTokens(Math.round(timing.tokensPerSecond));
      stats.push({ icon: Zap, short: `${rate} tok/s`, label: `${rate} tokens por segundo` });
    }
  }

  const input = formatTokens(
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens,
  );
  const output = formatTokens(usage.outputTokens);
  stats.push({
    icon: Hash,
    short: `${input} → ${output}`,
    label: `${input} tokens de entrada, ${output} de saída`,
  });
  return stats;
};

interface MessageViewProps {
  message: Message;
  models: Model[];
  retryable: boolean;
  onRetry: (message: Message) => void;
}

const MessageView = memo((props: MessageViewProps) => {
  if (props.message.role === 'assistant') return <Reply {...props} />;

  return (
    <article className="flex gap-3 text-base text-text">
      <span className="select-none text-accent" aria-hidden="true">
        &gt;
      </span>
      <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {textOf(props.message)}
      </p>
    </article>
  );
});

/** Componente próprio por causa da revelação, que a Mensagem do user não tem. */
const Reply = ({ message, models, retryable, onRetry }: MessageViewProps) => {
  // A revelação re-renderiza a cada frame, mesmo sem a Mensagem mudar.
  const text = useMemo(() => textOf(message), [message]);
  const { shown, revealing, waiting, animate } = useReveal(text, message.status);

  const name = modelName(message, models);
  const effort = message.effort && effortLabel(message.effort);
  // O Esforço é sabido desde o envio; o resto do rodapé espera o texto inteiro estar à vista.
  const stats: Stat[] = [
    ...(effort ? [{ icon: Gauge, short: effort, label: `esforço ${effort}` }] : []),
    ...(revealing ? [] : statsOf(message)),
  ];
  const cut = !revealing && message.stopReason === 'max_tokens';
  const copyable = !revealing && text.trim() !== '';
  const status =
    message.status === 'failed'
      ? lower(message.error?.message ?? messageFor('unknown'))
      : message.status === 'interrupted'
        ? 'resposta interrompida.'
        : null;

  return (
    <article aria-busy={revealing}>
      <Prose text={shown} open={revealing} animate={animate} caret={waiting} />
      {(status || name || stats.length > 0 || cut || retryable || copyable) && (
        <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
          {status && (
            <span className={message.status === 'failed' ? 'text-danger' : 'text-muted'}>
              {status}
            </span>
          )}
          {name && <span>{name}</span>}
          {stats.map(({ icon: Icon, short, label }) => (
            <span key={label} title={label} className="inline-flex items-center gap-1">
              <Icon size={12} aria-hidden />
              <span aria-hidden>{short}</span>
              <span className="sr-only">{label}</span>
            </span>
          ))}
          {cut && <span>cortada no limite de tokens</span>}
          {copyable && (
            <CopyButton text={text} className="inline-flex items-center gap-1 hover:text-text" />
          )}
          {retryable && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-accent hover:underline"
              onClick={() => onRetry(message)}
            >
              <RotateCcw size={12} aria-hidden />
              tentar de novo
            </button>
          )}
        </footer>
      )}
    </article>
  );
};

const nearBottom = (element: HTMLElement): boolean =>
  element.scrollHeight - element.scrollTop - element.clientHeight < 64;

export const Chat = ({
  ref,
  toi,
  provider,
  conversationId,
  models,
  modelOptions,
  model,
  effort,
  running,
  notice,
  noticeAction,
  onModelChange,
  onEffortChange,
  onManageModels,
  onSend,
  onStop,
  onRetry,
  onDismissNotice,
}: ChatProps) => {
  // As Mensagens mudam a cada frame do Fluxo; morando aqui, só o Chat re-renderiza.
  const messages = useMessages(toi, conversationId);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(preloadMarkdown, []);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  // Acompanha o fim só se a pessoa já estava lá. A lista cresce com Mensagens
  // novas e com a revelação, que avança entre uma mudança de Mensagens e outra.
  const followList = useCallback((content: HTMLDivElement) => {
    const observer = new ResizeObserver(() => {
      const element = scroller.current;
      if (element && following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);

  const last = messages.at(-1);
  const canRetry =
    !running &&
    last?.role === 'assistant' &&
    (last.status === 'interrupted' || last.status === 'failed');
  // Depois do `stop_reason` a resposta já acabou; só falta o corpo fechar.
  const finishing = running && last?.role === 'assistant' && last.stopReason !== null;

  const submit = async () => {
    const text = draft.trim();
    if (!text || running) return;

    following.current = true;
    setDraft('');
    const accepted = await onSend(text);
    if (!accepted) setDraft((current) => current || text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        // `relative`: o que é absoluto dentro (como `sr-only`) rola aqui, não estica a página.
        className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-8 pb-6 sm:px-8"
        onScroll={(event) => {
          following.current = nearBottom(event.currentTarget);
          setAtBottom(following.current);
        }}
      >
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-[44rem] flex-col justify-center pb-16">
            <p className="text-6xl leading-none font-bold tracking-tight text-text sm:text-7xl">
              toi
            </p>
            <p className="mt-5 text-base text-muted">
              converse com os modelos {provider.of.toLowerCase()} · o histórico fica neste navegador
            </p>
            <ul className="mt-8 hidden flex-wrap gap-x-6 gap-y-2 text-sm text-subtle sm:flex">
              <li>
                <kbd className="kbd">/</kbd> escrever
              </li>
              <li>
                <kbd className="kbd">n</kbd> nova conversa
              </li>
              <li>
                <kbd className="kbd">c</kbd> configurações
              </li>
              <li>
                <kbd className="kbd">esc</kbd> parar
              </li>
            </ul>
          </div>
        ) : (
          <div ref={followList} className="mx-auto flex max-w-[44rem] flex-col gap-9">
            {messages.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                models={models}
                retryable={canRetry && message === last}
                onRetry={onRetry}
              />
            ))}
          </div>
        )}
      </div>

      <div className="relative px-3 pb-3 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-t before:from-bg before:to-transparent sm:px-8 sm:pb-6">
        {!atBottom && messages.length > 0 && (
          <button
            type="button"
            aria-label="ir para o fim"
            className="absolute -top-12 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center border border-line bg-panel text-muted transition-colors hover:border-subtle hover:text-text"
            onClick={() => {
              const element = scroller.current;
              if (!element) return;
              following.current = true;
              element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
            }}
          >
            <ArrowDown size={15} aria-hidden />
          </button>
        )}
        {notice && (
          <div
            role="status"
            className="mx-auto mb-2 flex max-w-[44rem] items-baseline gap-3 text-sm"
          >
            <span className={notice.kind === 'error' ? 'text-danger' : 'text-accent'}>*</span>
            <span className={`flex-1 ${notice.kind === 'error' ? 'text-text' : 'text-muted'}`}>
              {notice.kind === 'error' ? lower(notice.error.message) : NOTICE_TEXT[notice.kind]}
            </span>
            {noticeAction && (
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={noticeAction.run}
              >
                {noticeAction.label}
              </button>
            )}
            <button
              type="button"
              className="self-center text-subtle hover:text-text"
              aria-label="fechar aviso"
              onClick={onDismissNotice}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        )}

        <form
          className="mx-auto max-w-[44rem] border border-line bg-panel transition-colors focus-within:border-subtle/60"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onClick={(event) => {
            // A caixa inteira é alvo do foco, não só a linha do textarea.
            if (event.target === event.currentTarget) input.current?.focus();
          }}
        >
          <label className="sr-only" htmlFor="composer-input">
            mensagem
          </label>
          <textarea
            id="composer-input"
            ref={input}
            rows={1}
            value={draft}
            placeholder={running ? 'respondendo…' : 'mensagem'}
            disabled={running}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
            className="block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base text-text outline-none placeholder:text-subtle disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-3 py-2 pr-2 pl-2.5">
            {model ? (
              <div className="flex min-w-0 items-center gap-1">
                <ModelPicker
                  options={modelOptions}
                  model={model}
                  disabled={running}
                  onChange={onModelChange}
                  onManage={onManageModels}
                />
                <EffortPicker effort={effort} disabled={running} onChange={onEffortChange} />
              </div>
            ) : (
              <span />
            )}
            {running ? (
              finishing ? (
                <span className="px-1 text-xs text-subtle">finalizando…</span>
              ) : (
                <button
                  type="button"
                  aria-label="parar"
                  title="parar (esc)"
                  className="grid size-7 flex-none place-items-center border border-line text-text transition-colors hover:border-subtle"
                  onClick={onStop}
                >
                  <Square size={10} fill="currentColor" aria-hidden />
                </button>
              )
            ) : (
              <button
                type="submit"
                aria-label="enviar"
                title="enviar (enter)"
                disabled={!draft.trim()}
                className="grid size-7 flex-none place-items-center bg-accent text-bg transition-colors hover:bg-accent-2 disabled:bg-line disabled:text-subtle"
              >
                <ArrowUp size={15} strokeWidth={2.25} aria-hidden />
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
};
