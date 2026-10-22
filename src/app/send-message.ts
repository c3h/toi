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
  appendText,
  closeMessage,
  leaseOf,
  type Message,
  type MessageStatus,
} from '../domain/message';
import { fieldsOf, type Model, type ModelRef } from '../domain/model';
import type { ChatProvider } from '../ports/chat-provider';
import type { Clock } from '../ports/clock';
import type { ConversationStore } from '../ports/conversation-store';
import type { TokenEstimator } from '../ports/token-estimator';
import { buildRequest } from './build-request';
import { createFlusher, type Flusher } from './flusher';

const DEFAULT_FLUSH_INTERVAL_MS = 300;

export interface RunDeps {
  store: ConversationStore;
  provider: ChatProvider;
  clock: Clock;
  estimator: TokenEstimator;
  newId: () => string;
  owner: string;
  flushIntervalMs?: number;
  onUpdate?: (message: Message) => void;
}

export interface SendOptions {
  conversationId: ConversationId;
  text: string;
  model: Model;
  signal: AbortSignal;
}

export interface RetryOptions {
  conversationId: ConversationId;
  messageId: MessageId;
  model: Model;
  signal: AbortSignal;
}

export interface RunResult {
  message: Message;
  truncated: boolean;
  persistError: AppErrorInfo | null;
}

export interface MessageRun {
  result: Promise<RunResult>;
  flush(): Promise<void>;
}

const storageFailed = (cause: unknown): AppErrorInfo =>
  toErrorInfo(appError('storage_failed', { cause }));

const nextSeq = (messages: Message[]): number => (messages.at(-1)?.seq ?? 0) + 1;

interface AssistantRun {
  conversationId: ConversationId;
  history: Message[];
  assistant: Message;
  model: Model;
  signal: AbortSignal;
}

const runAssistant = async (
  deps: RunDeps,
  { conversationId, history, assistant, model, signal }: AssistantRun,
  flusher: Flusher<Message>,
): Promise<RunResult> => {
  let draft = assistant;
  let finished = false;
  let truncated = false;
  let status: Exclude<MessageStatus, 'streaming'> = 'complete';
  let error: AppErrorInfo | null = null;

  const apply = (message: Message): void => {
    draft =
      message.status === 'streaming'
        ? { ...message, stream: leaseOf(deps.owner, deps.clock.now()) }
        : message;

    deps.onUpdate?.(draft);
    flusher.push(draft);
  };

  try {
    const built = buildRequest({
      messages: history,
      model,
      estimator: deps.estimator,
    });

    truncated = built.truncated;

    for await (const event of deps.provider.stream(built.request, signal)) {
      switch (event.type) {
        case 'started':
          apply({ ...draft, model: event.model, usage: event.usage });
          break;

        case 'delta':
          if (event.part === 'text') apply(appendText(draft, event.text));
          break;

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
      // Só `updatedAt`: Modelo e Título podem ter mudado enquanto a resposta chegava.
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

/** Aponta a Conversa para o Modelo do envio sobre o que está gravado, sem desfazer outra aba. */
const aimConversation = async (
  store: ConversationStore,
  id: ConversationId,
  model: ModelRef,
  now: number,
  title?: string,
): Promise<void> => {
  const updated = await store.updateConversation(id, (current) => ({
    ...current,
    ...fieldsOf(model),
    title: title ?? current.title,
    updatedAt: now,
  }));
  if (!updated) throw new Error(`Conversa ${id} não encontrada.`);
};

export const startSendMessage = async (
  deps: RunDeps,
  options: SendOptions,
): Promise<MessageRun> => {
  const text = options.text.trim();
  if (!text) throw new Error('sendMessage recebeu texto vazio.');

  const { conversation, messages } = await loadConversation(deps.store, options.conversationId);
  const now = deps.clock.now();
  const seq = nextSeq(messages);

  const user: Message = {
    id: deps.newId(),
    conversationId: conversation.id,
    seq,
    role: 'user',
    parts: [{ type: 'text', text }],
    status: 'complete',
    createdAt: now,
    completedAt: now,
    provider: null,
    model: null,
    usage: null,
    stopReason: null,
    error: null,
    stream: null,
  };

  const assistant: Message = {
    id: deps.newId(),
    conversationId: conversation.id,
    seq: seq + 1,
    role: 'assistant',
    parts: [],
    status: 'streaming',
    createdAt: now,
    completedAt: null,
    ...fieldsOf(options.model),
    usage: null,
    stopReason: null,
    error: null,
    stream: leaseOf(deps.owner, now),
  };

  await aimConversation(
    deps.store,
    conversation.id,
    options.model,
    now,
    messages.length === 0 ? titleFrom(text) : undefined,
  );
  await deps.store.putMessage(user);
  await deps.store.putMessage(assistant);
  deps.onUpdate?.(user);
  deps.onUpdate?.(assistant);

  return startAssistantRun(deps, {
    conversationId: conversation.id,
    history: [...messages, user],
    assistant,
    model: options.model,
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
  const assistant: Message = {
    ...target,
    ...fieldsOf(options.model),
    parts: [],
    status: 'streaming',
    completedAt: null,
    usage: null,
    stopReason: null,
    error: null,
    stream: leaseOf(deps.owner, now),
  };

  await aimConversation(deps.store, conversation.id, options.model, now);
  await deps.store.putMessage(assistant);
  deps.onUpdate?.(assistant);

  return startAssistantRun(deps, {
    conversationId: conversation.id,
    history: messages.filter((message) => message.id !== target.id),
    assistant,
    model: options.model,
    signal: options.signal,
  });
};
