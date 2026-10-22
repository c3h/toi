import { exceededLimit, type AttachmentUpload } from '../domain/attachment';
import { retitle, titleFrom, type Conversation } from '../domain/conversation';
import {
  appError,
  asAppError,
  brokenToolCallError,
  isAbortError,
  toErrorInfo,
  truncatedError,
  type AppErrorInfo,
} from '../domain/error';
import type { ConversationId, MessageId } from '../domain/ids';
import { closeMessage, type Message, type MessageStatus, type Part } from '../domain/message';
import { fieldsOf, refOf, type Effort, type Model, type ModelRef } from '../domain/model';
import { applyEvent, closeRound, startRound, withoutPendingCalls } from '../domain/round';
import { addUsage, emptyUsage, type StopReason } from '../domain/usage';
import { DEFAULT_TOOL_SPACE, eligibleUrls, sourceUrls } from '../domain/web';
import type { ChatProvider, ChatRequest } from '../ports/chat-provider';
import type { Clock } from '../ports/clock';
import type { ConversationStore, TurnWrite } from '../ports/conversation-store';
import type { SettingsStore } from '../ports/settings-store';
import type { TokenEstimator } from '../ports/token-estimator';
import type { WebTools } from '../ports/web-tools';
import {
  continuationOf,
  roundsTokens,
  selectHistory,
  toChatRequest,
  type Truncation,
} from './build-request';
import { createFlusher, type Flusher } from './flusher';
import {
  MAX_ROUNDS,
  readToolSpace,
  resultTokens,
  runCalls,
  searchLanguageOf,
  toolDefinitions,
  type ToolTurn,
} from './web-tools';

const DEFAULT_FLUSH_INTERVAL_MS = 300;

export interface RunDeps {
  store: ConversationStore;
  /** Lembra o Modelo e o Esforço do envio como default de uma Conversa nova e lê o espaço das Ferramentas. */
  settings: Pick<SettingsStore, 'saveLastModel' | 'saveLastEffort' | 'toolSpace'>;
  provider: ChatProvider;
  /** O Serviço das Ferramentas; `null` sem Chave, e então o envio não oferece Ferramentas. */
  tools: WebTools | null;
  /** Idioma do navegador (`pt-BR`): o default da Busca. */
  locale: string;
  clock: Clock;
  estimator: TokenEstimator;
  newId: () => string;
  flushIntervalMs?: number;
  onUpdate?: (message: Message) => void;
}

export interface SendOptions {
  conversationId: ConversationId;
  text: string;
  /** Já preparados; vão antes do texto, na ordem dada. */
  attachments: AttachmentUpload[];
  model: Model;
  effort: Effort;
  signal: AbortSignal;
}

export interface RetryOptions {
  conversationId: ConversationId;
  messageId: MessageId;
  model: Model;
  effort: Effort;
  signal: AbortSignal;
}

export interface RunResult {
  message: Message;
  /** A Mensagem do user quando `message` é a primeira resposta da Conversa; senão `null`. */
  opening: Message | null;
  truncated: Truncation | null;
  persistError: AppErrorInfo | null;
}

export interface MessageRun {
  result: Promise<RunResult>;
  flush(): Promise<void>;
}

const storageFailed = (cause: unknown): AppErrorInfo =>
  toErrorInfo(appError('storage_failed', { cause }));

const nextSeq = (messages: Message[]): number => (messages.at(-1)?.seq ?? 0) + 1;

/** Resposta nova em Fluxo. Tentar de novo reaproveita só id e posição: o relógio recomeça com ela. */
const streamingAssistant = (
  { id, conversationId, seq }: Pick<Message, 'id' | 'conversationId' | 'seq'>,
  model: ModelRef,
  effort: Effort,
  now: number,
): Message => ({
  id,
  conversationId,
  seq,
  role: 'assistant',
  parts: [],
  status: 'streaming',
  createdAt: now,
  completedAt: null,
  firstTokenAt: null,
  ...fieldsOf(model),
  effort,
  usage: null,
  stopReason: null,
  error: null,
});

interface AssistantRun {
  conversationId: ConversationId;
  history: Message[];
  assistant: Message;
  model: Model;
  effort: Effort;
  signal: AbortSignal;
}

/** `2026-10-22`, no fuso da pessoa. */
const dateOf = (now: number): string => {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * Uma resposta é uma ou mais Rodadas. Cada Rodada é uma requisição com o
 * prefixo do turno, montado uma vez (a `signature` do raciocínio o amarra),
 * mais as Rodadas já fechadas. Uma Rodada que termina pedindo Ferramenta
 * executa as chamadas e abre a próxima; a que termina por outro motivo é o
 * término lógico da Mensagem (`settled`): depois dele, erro ou abort não
 * reabrem a Mensagem.
 */
const runAssistant = async (
  deps: RunDeps,
  { conversationId, history, assistant, model, effort, signal }: AssistantRun,
  flusher: Flusher<Message>,
): Promise<RunResult> => {
  let draft = assistant;
  let settled = false;
  let truncated: Truncation | null = null;
  let status: Exclude<MessageStatus, 'streaming'> = 'complete';
  let error: AppErrorInfo | null = null;

  // O flush intermediário só agenda: nada entre Rodadas espera o IndexedDB.
  const apply = (message: Message): void => {
    draft = message;
    deps.onUpdate?.(draft);
    flusher.push(draft);
  };

  const settle = (stopReason: StopReason | null): void => {
    settled = true;
    apply({ ...draft, parts: withoutPendingCalls(draft.parts), stopReason });
  };

  try {
    const language = searchLanguageOf(deps.locale);
    const tools = deps.tools;
    // Sem conseguir ler a escolha (armazenamento bloqueado), o envio segue com o padrão.
    const toolSpace =
      tools === null ? null : await readToolSpace(deps.settings).catch(() => DEFAULT_TOOL_SPACE);
    const selected = selectHistory({
      messages: history,
      model,
      effort,
      estimator: deps.estimator,
      toolSpace,
    });
    truncated = selected.truncated;

    // Ler os Anexos pode levar tempo com arquivos grandes: parar no meio não chega à rede.
    const prefix = await toChatRequest(
      selected,
      (ids) => deps.store.readAttachments(ids),
      tools === null ? [] : toolDefinitions(dateOf(deps.clock.now()), language),
    );
    signal.throwIfAborted();

    const turn: ToolTurn | null =
      tools === null || selected.toolSpace === null
        ? null
        : {
            tools,
            clock: deps.clock,
            signal,
            language,
            space: selected.toolSpace,
            conclusion: selected.maxTokens,
            resultTokens: resultTokens(deps.estimator),
            calls: 0,
            rateLimitedUntil: null,
          };
    // O uso das Rodadas fechadas; a Rodada em curso soma o dela por cima.
    let closedUsage = emptyUsage();
    // Cresce só entre Rodadas: uma Busca não autoriza uma Leitura que corre ao lado dela.
    const eligible = turn === null ? new Set<string>() : eligibleUrls(history, draft.parts);

    for (let round = 1; ; round += 1) {
      const request: ChatRequest = {
        ...prefix,
        messages: [...prefix.messages, ...continuationOf(draft.parts)],
      };
      let state = startRound(draft.parts);
      let stop: StopReason | null = null;
      let finished = false;

      try {
        for await (const event of deps.provider.stream(request, signal)) {
          switch (event.type) {
            case 'started':
              apply({ ...draft, model: event.model, usage: addUsage(closedUsage, event.usage) });
              break;

            case 'usage':
              stop = event.stopReason;
              apply({ ...draft, usage: addUsage(closedUsage, event.usage) });
              break;

            case 'finished': {
              finished = true;
              // Sem pedir Ferramenta, a Rodada fecha a Mensagem. `max_tokens` no meio de uma
              // chamada a corta; uma chamada quebrada com outro motivo é defeito do Provedor.
              const final = stop !== 'tool_use' || turn === null;
              if (final && (stop === 'max_tokens' || !closeRound(state).broken)) settle(stop);
              break;
            }

            default: {
              const next = applyEvent(draft, state, event, deps.clock.now());
              state = next.round;
              if (next.message !== draft) apply(next.message);
            }
          }
        }
      } catch (cause) {
        // Depois de `finished` a Rodada acabou; só o corpo fechou mal. Abort ainda vale.
        if (!finished || signal.aborted) throw cause;
      }

      if (!finished) throw truncatedError();

      if (settled) break;

      const { calls, broken } = closeRound(state);
      if (broken || calls.length === 0 || turn === null) throw brokenToolCallError();
      if (round === MAX_ROUNDS) throw appError('tool_limit');

      const used = roundsTokens(
        draft.parts,
        draft.usage === null ? null : draft.usage.outputTokens,
        deps.estimator,
      );
      const results = await runCalls(turn, calls, eligible, used, round === MAX_ROUNDS - 1);
      apply({ ...draft, parts: [...draft.parts, ...results] });
      closedUsage = draft.usage ?? closedUsage;
      for (const url of sourceUrls(results)) eligible.add(url);
      // O Modelo que insiste em Ferramentas depois do espaço cheio ainda escreve a cada Rodada:
      // a seguinte só abre se o que as Rodadas somaram cabe no espaço.
      const added = results.reduce((sum, result) => sum + deps.estimator.estimate(result.content), 0);
      if (used + added > turn.space) throw appError('tool_limit');
    }
  } catch (cause) {
    // `settled` é o fim lógico: um erro/abort posterior não reabre a Mensagem.
    if (!settled) {
      const aborted = signal.aborted || isAbortError(cause);

      status = aborted ? 'interrupted' : 'failed';
      error = aborted ? null : toErrorInfo(asAppError(cause));
    }
  }

  apply(closeMessage(draft, status, deps.clock.now(), error));

  let persistError: AppErrorInfo | null = null;
  try {
    await flusher.flush();
  } catch (cause) {
    persistError = storageFailed(cause);
  }

  if (status === 'complete') {
    try {
      // Só `updatedAt`: Modelo, Esforço e Título podem ter mudado enquanto a resposta chegava.
      const now = deps.clock.now();
      await deps.store.updateConversation(conversationId, (current) => ({
        ...current,
        updatedAt: now,
      }));
    } catch (cause) {
      persistError ??= storageFailed(cause);
    }
  }

  return {
    message: draft,
    opening: history.length === 1 ? history[0]! : null,
    truncated,
    persistError,
  };
};

const startAssistantRun = (deps: RunDeps, run: AssistantRun): MessageRun => {
  const flusher = createFlusher<Message>(
    (message) => deps.store.putMessage(message),
    deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );

  return {
    result: runAssistant(deps, run, flusher),
    flush: () => flusher.flush(),
  };
};

const loadConversation = async (
  store: ConversationStore,
  id: ConversationId,
): Promise<{ conversation: Conversation; messages: Message[] }> => {
  const [conversation, messages] = await Promise.all([
    store.getConversation(id),
    store.listMessages(id),
  ]);
  if (!conversation) throw new Error(`Conversa ${id} não encontrada.`);

  return { conversation, messages };
};

/**
 * Aponta a Conversa para o Modelo e o Esforço do envio sobre o gravado, sem
 * desfazer outra aba. O Título derivado não passa por cima de um renomeado.
 */
const aim =
  (model: ModelRef, effort: Effort, now: number, title?: string) =>
  (current: Conversation): Conversation => ({
    ...(title === undefined ? current : retitle(current, title, 'derived')),
    ...fieldsOf(model),
    effort,
    updatedAt: now,
  });

/** Grava a mudança na Conversa, as Mensagens e os Anexos numa transação só. */
const startTurn = async (store: ConversationStore, turn: TurnWrite): Promise<void> => {
  const updated = await store.startTurn(turn);
  if (!updated) throw new Error(`Conversa ${turn.conversationId} não encontrada.`);
};

/**
 * O Modelo e o Esforço do envio viram o default de uma Conversa nova. É
 * conveniência: falhar ao gravá-los não impede o envio.
 */
const rememberChoice = async (
  settings: RunDeps['settings'],
  model: ModelRef,
  effort: Effort,
): Promise<void> => {
  await Promise.all([settings.saveLastModel(model), settings.saveLastEffort(effort)]).catch(
    () => undefined,
  );
};

export const startSendMessage = async (
  deps: RunDeps,
  options: SendOptions,
): Promise<MessageRun> => {
  const text = options.text.trim();
  const files = options.attachments.map(({ attachment }) => attachment);
  if (!text && files.length === 0) throw new Error('sendMessage recebeu uma Mensagem vazia.');
  if (exceededLimit(files) !== null) {
    throw new Error('sendMessage recebeu Anexos acima dos limites de uma Mensagem.');
  }

  const { conversation, messages } = await loadConversation(deps.store, options.conversationId);
  const now = deps.clock.now();
  const seq = nextSeq(messages);

  const parts: Part[] = [
    ...files.map((attachment): Part => ({ type: 'file', attachment })),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ];

  const user: Message = {
    id: deps.newId(),
    conversationId: conversation.id,
    seq,
    role: 'user',
    parts,
    status: 'complete',
    createdAt: now,
    completedAt: now,
    firstTokenAt: null,
    provider: null,
    model: null,
    effort: null,
    usage: null,
    stopReason: null,
    error: null,
  };

  const assistant = streamingAssistant(
    { id: deps.newId(), conversationId: conversation.id, seq: seq + 1 },
    options.model,
    options.effort,
    now,
  );

  const title = messages.length === 0 ? titleFrom(text || files[0]!.name) : undefined;
  await Promise.all([
    rememberChoice(deps.settings, refOf(options.model), options.effort),
    startTurn(deps.store, {
      conversationId: conversation.id,
      change: aim(options.model, options.effort, now, title),
      messages: [user, assistant],
      attachments: options.attachments,
    }),
  ]);
  deps.onUpdate?.(user);
  deps.onUpdate?.(assistant);

  return startAssistantRun(deps, {
    conversationId: conversation.id,
    history: [...messages, user],
    assistant,
    model: options.model,
    effort: options.effort,
    signal: options.signal,
  });
};

export const startRetryMessage = async (
  deps: RunDeps,
  options: RetryOptions,
): Promise<MessageRun> => {
  const { conversation, messages } = await loadConversation(deps.store, options.conversationId);
  const target = messages.find((message) => message.id === options.messageId);

  if (!target || target.role !== 'assistant') {
    throw new Error('retryMessage só aceita uma Mensagem do assistant.');
  }

  if (messages[messages.length - 1]?.id !== target.id) {
    throw new Error('retryMessage só aceita a última Mensagem da Conversa.');
  }

  if (target.status === 'streaming') {
    throw new Error('retryMessage não aceita uma Mensagem em Fluxo.');
  }

  const now = deps.clock.now();
  // A tentativa é do destino atual desde a primeira gravação, mesmo se falhar antes de `started`.
  const assistant = streamingAssistant(target, options.model, options.effort, now);

  await Promise.all([
    rememberChoice(deps.settings, refOf(options.model), options.effort),
    startTurn(deps.store, {
      conversationId: conversation.id,
      change: aim(options.model, options.effort, now),
      messages: [assistant],
      attachments: [],
    }),
  ]);
  deps.onUpdate?.(assistant);

  return startAssistantRun(deps, {
    conversationId: conversation.id,
    history: messages.filter((message) => message.id !== target.id),
    assistant,
    model: options.model,
    effort: options.effort,
    signal: options.signal,
  });
};
