import type { Conversation } from '../src/domain/conversation';
import type { Message } from '../src/domain/message';
import type { Model } from '../src/domain/model';
import type { ProviderId } from '../src/domain/ids';
import type { StreamEvent } from '../src/domain/stream';
import { emptyUsage } from '../src/domain/usage';
import type { ChatProvider, ChatRequest } from '../src/ports/chat-provider';
import type { FlowDeps } from '../src/app/flow';
import { MemoryLocks } from '../src/adapters/locks/memory';
import type { Clock } from '../src/ports/clock';
import type { ConversationStore } from '../src/ports/conversation-store';
import type { CredentialStore } from '../src/ports/credential-store';
import type { SettingsStore } from '../src/ports/settings-store';

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
  stopReason: null,
  error: null,
  stream: null,
  ...overrides,
});

export const makeConversation = (
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: 'Nova conversa',
  model: testModel.id,
  createdAt: 1,
  updatedAt: 1,
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

  async getMessage(id: string): Promise<Message | null> {
    return this.messages.get(id) ?? null;
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
}

export class MemoryCredentialStore implements CredentialStore {
  readonly keys = new Map<ProviderId, string>();

  async get(provider: ProviderId): Promise<string | null> {
    return this.keys.get(provider) ?? null;
  }

  async set(provider: ProviderId, key: string): Promise<void> {
    this.keys.set(provider, key);
  }

  async delete(provider: ProviderId): Promise<void> {
    this.keys.delete(provider);
  }
}

export class MemorySettingsStore implements SettingsStore {
  readonly values = new Map<string, unknown>();

  async clear(): Promise<void> {
    this.values.clear();
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

/** Resposta mínima que fecha em `complete`. */
export const replyEvents = (text = 'Olá'): StreamEvent[] => [
  { type: 'started', model: testModel.id, usage: usage(10, 0) },
  { type: 'delta', index: 0, part: 'text', text },
  { type: 'finished' },
];

/** Emite um `delta`, sinaliza `delta` e espera o abort. */
export const gatedProvider = () => {
  let signalDelta: () => void = () => undefined;
  const delta = new Promise<void>((resolve) => {
    signalDelta = resolve;
  });

  const provider = new ScriptedProvider(async function* (
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
    yield { type: 'delta', index: 0, part: 'text', text: 'a' };
    signalDelta();

    await new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }

      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  });

  return { provider, delta };
};

interface BuiltDeps {
  store: MemoryStore;
  deps: Omit<FlowDeps, 'provider'>;
  clock: ReturnType<typeof fixedClock>;
}

/** `FlowDeps` sem Provedor, com locks que simulam outra aba; não grava nada. */
export const flowDeps = (store = new MemoryStore()): BuiltDeps => {
  const clock = fixedClock(50_000);
  let next = 0;

  return {
    store,
    clock,
    deps: {
      store,
      clock,
      estimator: { estimate: () => 1 },
      newId: () => `id-${(next += 1)}`,
      owner: 'tab-a',
      flushIntervalMs: 60_000,
      locks: new MemoryLocks({ crossTab: true }),
    },
  };
};

/** `flowDeps` com a Conversa `c1` gravada. */
export const baseDeps = async (store = new MemoryStore()): Promise<BuiltDeps> => {
  const built = flowDeps(store);
  await store.putConversation(makeConversation('c1'));
  return built;
};

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
