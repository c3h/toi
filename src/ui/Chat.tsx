import { ArrowDown, ArrowUp, RotateCcw, Square, X } from 'lucide-react';
import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import type { ProviderInfo, Toi } from '../app/toi';
import { messageFor, type AppErrorInfo } from '../domain/error';
import type { ConversationId } from '../domain/ids';
import { textOf, type Message } from '../domain/message';
import { findModel, refFrom, type Model } from '../domain/model';
import { CopyButton } from './CopyButton';
import { ModelPicker } from './ModelPicker';
import { preloadMarkdown, Prose } from './Prose';
import { formatTokens, lower } from './support';
import { useMessages } from './use-messages';

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
  running: boolean;
  notice: Notice | null;
  noticeAction: NoticeAction | null;
  onModelChange: (model: Model) => void;
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

const metaLine = (message: Message, models: Model[]): string[] => {
  const parts: string[] = [];
  const model = findModel(models, refFrom(message));
  if (message.model) parts.push((model?.displayName ?? message.model).toLowerCase());

  // Fora de `complete` a contagem de saída é parcial e enganaria.
  if (message.usage && message.status === 'complete') {
    const input =
      message.usage.inputTokens +
      message.usage.cacheCreationInputTokens +
      message.usage.cacheReadInputTokens;
    parts.push(`${formatTokens(input)} tokens de entrada`);
    parts.push(`${formatTokens(message.usage.outputTokens)} de saída`);
  }
  if (message.stopReason === 'max_tokens') parts.push('cortada no limite de tokens');
  return parts;
};

interface MessageViewProps {
  message: Message;
  models: Model[];
  retryable: boolean;
  onRetry: (message: Message) => void;
}

const MessageView = memo(({ message, models, retryable, onRetry }: MessageViewProps) => {
  const text = textOf(message);

  if (message.role === 'user') {
    return (
      <article className="flex gap-3 text-base text-text">
        <span className="select-none text-accent" aria-hidden="true">
          &gt;
        </span>
        <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
      </article>
    );
  }

  const meta = metaLine(message, models);
  const copyable = message.status !== 'streaming' && text.trim() !== '';
  const status =
    message.status === 'failed'
      ? lower(message.error?.message ?? messageFor('unknown'))
      : message.status === 'interrupted'
        ? 'resposta interrompida.'
        : null;

  return (
    <article aria-busy={message.status === 'streaming'}>
      <Prose text={text} streaming={message.status === 'streaming'} />
      {(status || meta.length > 0 || retryable || copyable) && (
        <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
          {status && (
            <span className={message.status === 'failed' ? 'text-danger' : 'text-muted'}>
              {status}
            </span>
          )}
          {meta.length > 0 && <span>{meta.join(' · ')}</span>}
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
});

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
  running,
  notice,
  noticeAction,
  onModelChange,
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

  // Acompanha o fim só se a pessoa já estava lá.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

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
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-8 pb-6 sm:px-8"
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
          <div className="mx-auto flex max-w-[44rem] flex-col gap-9">
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
            className="absolute -top-12 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-line bg-panel text-muted shadow-md shadow-black/20 transition-colors hover:border-subtle hover:text-text"
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
          className="mx-auto max-w-[44rem] rounded-lg border border-line bg-panel transition-colors focus-within:border-subtle/60"
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
              <ModelPicker
                options={modelOptions}
                model={model}
                disabled={running}
                onChange={onModelChange}
                onManage={onManageModels}
              />
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
                  className="grid size-7 flex-none place-items-center rounded-md border border-line text-text transition-colors hover:border-subtle"
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
                className="grid size-7 flex-none place-items-center rounded-md bg-accent text-bg transition-colors hover:bg-accent-2 disabled:bg-line disabled:text-subtle"
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
