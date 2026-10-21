import { titleFrom, type Conversation } from '../domain/conversation';
import { AppError, isAbortError, toErrorInfo, type AppErrorInfo } from '../domain/error';
import type { ConversationId, MessageId } from '../domain/ids';
import {
  appendText,
  closeMessage,
  leaseOf,
  type Message,
  type MessageStatus,
} from '../domain/message';
import type { Model } from '../domain/model';
import type { ChatProvider } from '../ports/chat-provider';
import type { Clock } from '../ports/clock';
import type { ConversationStore } from '../ports/conversation-store';
import type { TokenEstimator } from '../ports/token-estimator';
import { buildRequest } from './build-request';
import { createFlusher } from './flusher';

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

export interface RunResult {
  message: Message;
  truncated: boolean;
}

const asAppError = (error: unknown): AppError =>
  error instanceof AppError
    ? error
    : new AppError('unknown', 'Algo deu errado.', { cause: error });

const nextSeq = (messages: Message[]): number => (messages.at(-1)?.seq ?? 0) + 1;

const runAssistant = async (
  deps: RunDeps,
  conversation: Conversation,
  history: Message[],
  assistant: Message,
  model: Model,
  signal: AbortSignal,
): Promise<RunResult> => {
  const flusher = createFlusher<Message>(
    (message) => deps.store.putMessage(message),
    deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );

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
          apply({ ...draft, usage: event.usage });
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
      throw new AppError('unreachable', 'A resposta terminou antes do fim.');
    }
  } catch (cause) {
    const aborted = signal.aborted || isAbortError(cause);

    status = aborted ? 'interrupted' : 'failed';
    error = aborted ? null : toErrorInfo(asAppError(cause));
  }

  apply(closeMessage(draft, status, deps.clock.now(), error));

  await flusher.flush();

  if (status === 'complete') {
    await deps.store.putConversation({ ...conversation, updatedAt: deps.clock.now() });
  }

  return { message: draft, truncated };
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

export const sendMessage = async (deps: RunDeps, options: SendOptions): Promise<RunResult> => {
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
    model: options.model.id,
    usage: null,
    stopReason: null,
    error: null,
    stream: leaseOf(deps.owner, now),
  };

  const updated: Conversation = {
    ...conversation,
    model: options.model.id,
    title: messages.length === 0 ? titleFrom(text) : conversation.title,
    updatedAt: now,
  };

  await deps.store.putConversation(updated);
  await deps.store.putMessage(user);
  await deps.store.putMessage(assistant);
  deps.onUpdate?.(user);

  return runAssistant(deps, updated, [...messages, user], assistant, options.model, options.signal);
};

export interface RetryOptions {
  conversationId: ConversationId;
  messageId: MessageId;
  model: Model;
  signal: AbortSignal;
}

export const retryMessage = async (deps: RunDeps, options: RetryOptions): Promise<RunResult> => {
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
  const assistant: Message = {
    ...target,
    parts: [],
    status: 'streaming',
    completedAt: null,
    usage: null,
    stopReason: null,
    error: null,
    stream: leaseOf(deps.owner, now),
  };

  const updated: Conversation = { ...conversation, model: options.model.id, updatedAt: now };

  await deps.store.putConversation(updated);
  await deps.store.putMessage(assistant);

  return runAssistant(
    deps,
    updated,
    messages.filter((message) => message.id !== target.id),
    assistant,
    options.model,
    options.signal,
  );
};
