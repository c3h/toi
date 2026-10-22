import type { Conversation } from '../src/domain/conversation';
import { appError } from '../src/domain/error';
import type { Message } from '../src/domain/message';
import type { Model, ModelPicks, ModelRef } from '../src/domain/model';
import type { ProviderId } from '../src/domain/ids';
import type { StreamEvent } from '../src/domain/stream';
import { emptyUsage } from '../src/domain/usage';
import type { ChatProvider, ChatRequest, ProviderAdapter } from '../src/ports/chat-provider';
import type { FlowDeps } from '../src/app/flow';
import { anthropicInfo } from '../src/adapters/providers/anthropic/info';
import { anthropicFamily } from '../src/adapters/providers/anthropic/models';
import type { Clock } from '../src/ports/clock';
import type { ConversationStore } from '../src/ports/conversation-store';
import type { CredentialStore } from '../src/ports/credential-store';
import type { LockMode, Locks, Release } from '../src/ports/locks';
import type { SettingsStore } from '../src/ports/settings-store';

export const testModel: Model = {
  provider: 'anthropic',
  id: 'claude-sonnet-test',
  displayName: 'Claude Test',
  family: 'sonnet',
  maxTokens: 8192,
  maxInputTokens: 200_000,
  createdAt: '2026-01-01T00:00:00Z',
};

/** Um Modelo da Anthropic com a família que o Provedor daria ao id. */
export const makeModel = (id: string, overrides: Partial<Model> = {}): Model => ({
  ...testModel,
  id,
  displayName: id,
  family: anthropicFamily(id),
  ...overrides,
});

/** Os Provedores de `createToi`: um só, criado por `create` a cada Chave. */
export const providersOf = (create: (apiKey: string) => ChatProvider): ProviderAdapter[] => [
  { info: anthropicInfo, create },
];

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
  firstTokenAt: null,
  provider: overrides.role === 'assistant' ? 'anthropic' : null,
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  ...overrides,
});

export const makeConversation = (
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: 'Nova conversa',
  provider: testModel.provider,
  model: testModel.id,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

export class MemoryStore implements ConversationStore {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message>();
  readonly #watchers = new Set<() => void>();

  #changed(): void {
    for (const watcher of this.#watchers) watcher();
  }

  #watch<T>(read: () => Promise<T>, listener: (value: T) => void): () => void {
    const emit = () => void read().then(listener);
    this.#watchers.add(emit);
    emit();
    return () => {
      this.#watchers.delete(emit);
    };
  }

  watchConversations(listener: (conversations: Conversation[]) => void): () => void {
    return this.#watch(() => this.listConversations(), listener);
  }

  watchMessages(conversationId: string, listener: (messages: Message[]) => void): () => void {
    return this.#watch(() => this.listMessages(conversationId), listener);
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async putConversation(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.id, conversation);
    this.#changed();
  }

  async updateConversation(
    id: string,
    change: (conversation: Conversation) => Conversation,
  ): Promise<Conversation | null> {
    const current = this.conversations.get(id);
    if (!current) return null;

    const updated = change(current);
    this.conversations.set(id, updated);
    this.#changed();
    return updated;
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    for (const [messageId, message] of this.messages) {
      if (message.conversationId === id) this.messages.delete(messageId);
    }
    this.#changed();
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
    this.#changed();
  }

  async listStreamingMessages(): Promise<Message[]> {
    return [...this.messages.values()].filter((message) => message.status === 'streaming');
  }

  async clearConversations(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
    this.#changed();
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

  async clear(): Promise<void> {
    this.keys.clear();
  }
}

/** Locks de uma página só; duas instâncias de `Flow` com o mesmo objeto simulam duas abas. */
export class MemoryLocks implements Locks {
  readonly #held = new Map<string, { mode: LockMode; count: number }>();

  async tryAcquire(name: string, mode: LockMode = 'exclusive'): Promise<Release | null> {
    const current = this.#held.get(name);
    if (current && (mode === 'exclusive' || current.mode === 'exclusive')) return null;

    this.#held.set(name, { mode, count: (current?.count ?? 0) + 1 });

    let released = false;
    return async () => {
      if (released) return;
      released = true;

      const holding = this.#held.get(name);
      if (!holding || holding.count <= 1) this.#held.delete(name);
      else holding.count -= 1;
    };
  }
}

export class MemorySettingsStore implements SettingsStore {
  readonly values = new Map<string, unknown>();

  async models(provider: ProviderId): Promise<Model[] | null> {
    return (this.values.get(`models:${provider}`) as Model[] | undefined) ?? null;
  }

  async saveModels(provider: ProviderId, models: Model[]): Promise<void> {
    this.values.set(`models:${provider}`, models);
  }

  async lastModel(): Promise<ModelRef | null> {
    return (this.values.get('lastModel') as ModelRef | undefined) ?? null;
  }

  async saveLastModel(model: ModelRef): Promise<void> {
    this.values.set('lastModel', model);
  }

  async modelPicks(): Promise<ModelPicks | null> {
    return (this.values.get('modelPicks') as ModelPicks | undefined) ?? null;
  }

  async saveModelPicks(picks: ModelPicks): Promise<void> {
    this.values.set('modelPicks', picks);
  }

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
  readonly models: Model[];

  constructor(script: Script, models: Model[] = [testModel]) {
    this.script = script;
    this.models = models;
  }

  async listModels(): Promise<Model[]> {
    return this.models;
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

/** Recusa a Chave ao listar Modelos. */
export class FailingProvider extends ScriptedProvider {
  override async listModels(): Promise<Model[]> {
    throw appError('invalid_credential');
  }
}

/** Resposta mínima que fecha em `complete`. */
export const replyEvents = (text = 'Olá'): StreamEvent[] => [
  { type: 'started', model: testModel.id, usage: usage(10, 0) },
  { type: 'delta', index: 0, part: 'text', text },
  { type: 'finished' },
];

/** Uma Promise e quem a resolve, para o teste marcar um ponto do Fluxo. */
export const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Emite um `delta`, sinaliza `delta` e espera o abort. */
export const gatedProvider = () => {
  const { promise: delta, resolve: signalDelta } = deferred();

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
      flushIntervalMs: 60_000,
      locks: new MemoryLocks(),
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
