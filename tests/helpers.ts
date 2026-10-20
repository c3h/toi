import type { Conversation } from '../src/domain/conversation';
import type { Message } from '../src/domain/message';
import type { Model } from '../src/domain/model';
import type { StreamEvent } from '../src/domain/stream';
import { emptyUsage } from '../src/domain/usage';
import type { ChatProvider, ChatRequest } from '../src/ports/chat-provider';
import type { Clock } from '../src/ports/clock';
import type { ConversationStore } from '../src/ports/conversation-store';

export const testModel: Model = {
  id: 'claude-test',
  displayName: 'Claude Test',
  maxTokens: 8192,
  maxInputTokens: 200_000,
  createdAt: '2026-01-01T00:00:00Z',
};

export const streamOf = (chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
};

export const collect = async <T>(generator: AsyncGenerator<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of generator) items.push(item);
  return items;
};

export const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');

export const sse = (frames: Array<{ event: string; data: unknown }>): string =>
  frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join('');

export const makeMessage = (
  overrides: Partial<Message> & Pick<Message, 'id' | 'conversationId' | 'seq' | 'role'>,
): Message => ({
  parts: [],
  status: 'complete',
  createdAt: 1_000,
  completedAt: 1_000,
  model: null,
  usage: null,
  error: null,
  stream: null,
  ...overrides,
});

export class MemoryStore implements ConversationStore {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message>();

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async putConversation(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.id, conversation);
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    for (const [messageId, message] of this.messages) {
      if (message.conversationId === id) this.messages.delete(messageId);
    }
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return [...this.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.seq - b.seq);
  }

  async putMessage(message: Message): Promise<void> {
    this.messages.set(message.id, message);
  }

  async listStreamingMessages(): Promise<Message[]> {
    return [...this.messages.values()].filter((message) => message.status === 'streaming');
  }

  async clearConversations(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
  }

  async clearAll(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
  }
}

export const fixedClock = (start = 10_000): Clock & { set(value: number): void } => {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
  };
};

type Script = StreamEvent[] | ((signal: AbortSignal) => AsyncIterable<StreamEvent>);

export class ScriptedProvider implements ChatProvider {
  readonly requests: ChatRequest[] = [];
  readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  async listModels(): Promise<Model[]> {
    return [testModel];
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    this.requests.push(request);

    if (typeof this.script === 'function') {
      yield* this.script(signal);
      return;
    }

    for (const event of this.script) {
      if (signal.aborted) throw abortError();
      yield event;
    }
  }
}

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const errorEnvelope = (type: string, message: string) => ({
  type: 'error',
  error: { type, message },
});

export const usage = (input: number, output: number) => ({
  ...emptyUsage(),
  inputTokens: input,
  outputTokens: output,
});
