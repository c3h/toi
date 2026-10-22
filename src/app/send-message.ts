import { exceededLimit, type AttachmentUpload } from '../domain/attachment';
import { titleFrom, type Conversation } from '../domain/conversation';
import {
  appError,
  asAppError,
  isAbortError,
  toErrorInfo,
  truncatedError,
  type AppErrorInfo,
} from '../domain/error';
import type { ConversationId, MessageId } from '../domain/ids';
import {
  closeMessage,
  receiveDelta,
  type Message,
  type MessageStatus,
  type Part,
} from '../domain/message';
import { fieldsOf, refOf, type Effort, type Model, type ModelRef } from '../domain/model';
import type { ChatProvider } from '../ports/chat-provider';
import type { Clock } from '../ports/clock';
import type { ConversationStore, TurnWrite } from '../ports/conversation-store';
import type { SettingsStore } from '../ports/settings-store';
import type { TokenEstimator } from '../ports/token-estimator';
import { selectHistory, toChatRequest, type Truncation } from './build-request';
import { createFlusher, type Flusher } from './flusher';

const DEFAULT_FLUSH_INTERVAL_MS = 300;

export interface RunDeps {
  store: ConversationStore;
  /** Só para lembrar o Modelo e o Esforço do envio como default de uma Conversa nova. */
  settings: Pick<SettingsStore, 'saveLastModel' | 'saveLastEffort'>;
  provider: ChatProvider;
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

const runAssistant = async (
  deps: RunDeps,
  { conversationId, history, assistant, model, effort, signal }: AssistantRun,
  flusher: Flusher<Message>,
): Promise<RunResult> => {
  let draft = assistant;
  let finished = false;
  let truncated: Truncation | null = null;
  let status: Exclude<MessageStatus, 'streaming'> = 'complete';
  let error: AppErrorInfo | null = null;

  const apply = (message: Message): void => {
    draft = message;
    deps.onUpdate?.(draft);
    flusher.push(draft);
  };

  try {
    const selected = selectHistory({
      messages: history,
      model,
      effort,
      estimator: deps.estimator,
    });
    truncated = selected.truncated;

    // Ler os Anexos pode levar tempo com arquivos grandes: parar no meio não chega à rede.
    const request = await toChatRequest(selected, (ids) => deps.store.readAttachments(ids));
    signal.throwIfAborted();

    for await (const event of deps.provider.stream(request, signal)) {
      switch (event.type) {
        case 'started':
          apply({ ...draft, model: event.model, usage: event.usage });
          break;

        case 'delta': {
          const next = receiveDelta(draft, event.part, event.text, deps.clock.now());
          if (next !== draft) apply(next);
          break;
        }

        case 'usage':
          apply({ ...draft, usage: event.usage, stopReason: event.stopReason });
          break;

        case 'finished':
          finished = true;
          break;

        case 'part_started':
        case 'part_finished':
          break;
      }
    }

    if (!finished) {
      throw truncatedError();
    }
  } catch (cause) {
    // `finished` é o fim lógico: um erro/abort posterior não reabre a Mensagem.
    if (!finished) {
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

  return { message: draft, truncated, persistError };
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

/** Aponta a Conversa para o Modelo e o Esforço do envio sobre o gravado, sem desfazer outra aba. */
const aim =
  (model: ModelRef, effort: Effort, now: number, title?: string) =>
  (current: Conversation): Conversation => ({
    ...current,
    ...fieldsOf(model),
    effort,
    title: title ?? current.title,
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
