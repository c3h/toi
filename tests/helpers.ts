import type { Attachment, AttachmentUpload } from '../src/domain/attachment';
import type { Conversation } from '../src/domain/conversation';
import { appError, missingAttachmentError } from '../src/domain/error';
import type { Message, Part } from '../src/domain/message';
import type { Effort, Model, ModelPicks, ModelRef } from '../src/domain/model';
import type { CredentialOwner, ProviderId } from '../src/domain/ids';
import type { StreamEvent } from '../src/domain/stream';
import { emptyUsage, type StopReason } from '../src/domain/usage';
import type { ChatProvider, ChatRequest, ProviderAdapter } from '../src/ports/chat-provider';
import type { FlowDeps } from '../src/app/flow';
import type { RunDeps, SendOptions } from '../src/app/send-message';
import { anthropicInfo } from '../src/adapters/providers/anthropic/info';
import { anthropicFamily } from '../src/adapters/providers/anthropic/models';
import type { Clock } from '../src/ports/clock';
import type {
  ConversationStore,
  HistorySnapshot,
  TurnWrite,
} from '../src/ports/conversation-store';
import type { CredentialStore } from '../src/ports/credential-store';
import type { LockMode, Locks, Release } from '../src/ports/locks';
import type { SettingsStore } from '../src/ports/settings-store';
import type { FetchOutcome, SearchOutcome, WebTools } from '../src/ports/web-tools';
import type { ToolSpace } from '../src/domain/web';

export const testModel: Model = {
  provider: 'anthropic',
  id: 'claude-sonnet-test',
  displayName: 'Claude Test',
  family: 'sonnet',
  maxTokens: 8192,
  maxInputTokens: 200_000,
  createdAt: '2026-01-01T00:00:00Z',
  reasoningOff: true,
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
  effort: null,
  usage: null,
  stopReason: null,
  error: null,
  ...overrides,
});

const upload = (attachment: Attachment, blob: Blob): AttachmentUpload => ({ attachment, blob });

/** Bytes de mentira do tamanho pedido: o teste não lê imagem nem PDF. */
const bytes = (size: number, type: string): Blob => new Blob([new Uint8Array(size)], { type });

export const textFile = (id: string, content = 'conteúdo'): AttachmentUpload => {
  const blob = new Blob([content], { type: 'text/plain' });
  return upload({ id, kind: 'text', name: `${id}.txt`, size: blob.size }, blob);
};

export const pdfFile = (id: string, pages: number | null = 1, size = 1_000): AttachmentUpload =>
  upload({ id, kind: 'pdf', name: `${id}.pdf`, size, pages }, bytes(size, 'application/pdf'));

export const imageFile = (id: string, size = 1_000): AttachmentUpload =>
  upload(
    { id, kind: 'image', name: `${id}.png`, size, mediaType: 'image/png', width: 100, height: 50 },
    bytes(size, 'image/png'),
  );

export const filePart = ({ attachment }: AttachmentUpload): Part => ({ type: 'file', attachment });

/** Um envio de texto para `c1`; o teste muda só o que importa a ele. */
export const sendInput = (
  overrides: Partial<Omit<SendOptions, 'signal'>> = {},
): Omit<SendOptions, 'signal'> => ({
  conversationId: 'c1',
  text: 'Pergunta',
  attachments: [],
  model: testModel,
  effort: 'low',
  ...overrides,
});

export const makeConversation = (
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: 'Nova conversa',
  titleSource: 'derived',
  provider: testModel.provider,
  model: testModel.id,
  effort: 'low',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

export class MemoryStore implements ConversationStore {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message>();
  readonly attachments = new Map<string, { conversationId: string; blob: Blob }>();
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

  async startTurn(turn: TurnWrite): Promise<Conversation | null> {
    const current = this.conversations.get(turn.conversationId);
    if (!current) return null;

    const updated = turn.change(current);
    this.conversations.set(updated.id, updated);
    for (const message of turn.messages) this.messages.set(message.id, message);
    for (const { attachment, blob } of turn.attachments) {
      this.attachments.set(attachment.id, { conversationId: turn.conversationId, blob });
    }
    this.#changed();
    return updated;
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    for (const [messageId, message] of this.messages) {
      if (message.conversationId === id) this.messages.delete(messageId);
    }
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.conversationId === id) this.attachments.delete(attachmentId);
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

  async readAttachments(ids: string[]): Promise<Blob[]> {
    return ids.map((id) => {
      const stored = this.attachments.get(id);
      if (!stored) throw missingAttachmentError();
      return stored.blob;
    });
  }

  async listStreamingMessages(): Promise<Message[]> {
    return [...this.messages.values()].filter((message) => message.status === 'streaming');
  }

  async clearConversations(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
    this.attachments.clear();
    this.#changed();
  }

  async snapshot(): Promise<HistorySnapshot> {
    const conversations = await this.listConversations();
    return {
      conversations: await Promise.all(
        conversations.map(async (conversation) => ({
          conversation,
          messages: await this.listMessages(conversation.id),
        })),
      ),
      attachments: new Map([...this.attachments].map(([id, { blob }]) => [id, blob])),
    };
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly #keys = new Map<CredentialOwner, string>();

  async get(owner: CredentialOwner): Promise<string | null> {
    return this.#keys.get(owner) ?? null;
  }

  async set(owner: CredentialOwner, key: string): Promise<void> {
    this.#keys.set(owner, key);
  }

  async delete(owner: CredentialOwner): Promise<void> {
    this.#keys.delete(owner);
  }

  async clear(): Promise<void> {
    this.#keys.clear();
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

  async lastEffort(): Promise<Effort | null> {
    return (this.values.get('lastEffort') as Effort | undefined) ?? null;
  }

  async saveLastEffort(effort: Effort): Promise<void> {
    this.values.set('lastEffort', effort);
  }

  async modelPicks(): Promise<ModelPicks | null> {
    return (this.values.get('modelPicks') as ModelPicks | undefined) ?? null;
  }

  async saveModelPicks(picks: ModelPicks): Promise<void> {
    this.values.set('modelPicks', picks);
  }

  async toolSpace(): Promise<ToolSpace | null> {
    return (this.values.get('toolSpace') as ToolSpace | undefined) ?? null;
  }

  async saveToolSpace(space: ToolSpace): Promise<void> {
    this.values.set('toolSpace', space);
  }

  async titleModel(): Promise<ModelRef | null> {
    return (this.values.get('titleModel') as ModelRef | undefined) ?? null;
  }

  async saveTitleModel(model: ModelRef): Promise<void> {
    this.values.set('titleModel', model);
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

/** Responde cada pedido com um script; `{ rounds }` dá um por pedido, como as Rodadas de uma resposta. */
export class ScriptedProvider implements ChatProvider {
  readonly requests: ChatRequest[] = [];
  readonly models: Model[];
  /** Script único responde todo pedido; Rodadas, uma por pedido, e pedido fora delas falha. */
  readonly #scriptFor: (request: number) => Script | undefined;

  constructor(script: Script | { rounds: Script[] }, models: Model[] = [testModel]) {
    this.#scriptFor = 'rounds' in script ? (request) => script.rounds[request] : () => script;
    this.models = models;
  }

  async listModels(signal: AbortSignal): Promise<Model[]> {
    signal.throwIfAborted();
    return this.models;
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const script = this.#scriptFor(this.requests.length);
    this.requests.push(request);
    if (!script) throw new Error('Rodada fora do script.');

    if (typeof script === 'function') {
      yield* script(signal);
      return;
    }

    for (const event of script) {
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

/** Os Eventos de um bloco de texto, como o adaptador os emite. */
export const textEvents = (text: string, index = 0): StreamEvent[] => [
  { type: 'part_started', index, part: { type: 'text' } },
  { type: 'delta', index, part: 'text', text },
  { type: 'part_finished', index },
];

/** Os Eventos de uma chamada de Ferramenta, com o input inteiro num delta. */
export const toolCall = (index: number, callId: string, tool: string, json: string): StreamEvent[] => [
  { type: 'part_started', index, part: { type: 'tool_call', callId, tool } },
  { type: 'delta', index, part: 'input', text: json },
  { type: 'part_finished', index },
];

/** Uma Rodada inteira em volta dos blocos, do `started` ao `finished`. */
export const round = (body: StreamEvent[], stopReason: StopReason, output = 5): StreamEvent[] => [
  { type: 'started', model: testModel.id, usage: usage(10, 0) },
  ...body,
  { type: 'usage', usage: usage(10, output), stopReason },
  { type: 'finished' },
];

/** Resposta mínima que fecha em `complete`. */
export const replyEvents = (text = 'Olá'): StreamEvent[] => round(textEvents(text), 'end_turn');

/** Uma Promise e quem a resolve, para o teste marcar um ponto do Fluxo. */
export const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Pendura até o `signal` abortar e então rejeita como o `fetch`. */
export const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });

/** Emite `text` num bloco aberto, sinaliza `delta` e espera o abort. */
export const gatedProvider = (text = 'a') => {
  const { promise: delta, resolve: signalDelta } = deferred();

  const provider = new ScriptedProvider(async function* (
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
    yield { type: 'part_started', index: 0, part: { type: 'text' } };
    yield { type: 'delta', index: 0, part: 'text', text };
    signalDelta();

    await untilAborted(signal);
  });

  return { provider, delta };
};

interface BuiltDeps {
  store: MemoryStore;
  /** Sem Provedor, que cada teste dá, e sem Serviço, até o teste dar um. */
  deps: Omit<RunDeps, 'provider'> & Pick<FlowDeps, 'locks'>;
  clock: ReturnType<typeof fixedClock>;
}

/** As dependências de um envio sem Provedor, com locks que simulam outra aba; não grava nada. */
export const flowDeps = (store = new MemoryStore()): BuiltDeps => {
  const clock = fixedClock(50_000);
  let next = 0;

  return {
    store,
    clock,
    deps: {
      store,
      settings: new MemorySettingsStore(),
      tools: null,
      clock,
      estimator: { estimate: () => 1, estimateAttachment: () => 1 },
      newId: () => `id-${(next += 1)}`,
      flushIntervalMs: 60_000,
      locks: new MemoryLocks(),
      locale: 'pt-BR',
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

type Answer<T> = T | Error | ((signal: AbortSignal) => Promise<T>);

const answer = async <T>(value: Answer<T>, signal: AbortSignal): Promise<T> => {
  if (typeof value === 'function') return (value as (signal: AbortSignal) => Promise<T>)(signal);
  if (value instanceof Error) throw value;
  return value;
};

/** Um Serviço de Ferramentas que responde o que o teste mandou e guarda os pedidos. */
export class FakeWebTools implements WebTools {
  readonly searches: Array<{ text: string; language: string }> = [];
  readonly fetches: string[][] = [];
  searchAnswer: Answer<SearchOutcome> = { hits: [] };
  fetchAnswer: Answer<FetchOutcome> = { pages: [], failures: [] };
  verifyAnswer: Answer<void> = undefined;

  async search(query: { text: string; language: string }, signal: AbortSignal): Promise<SearchOutcome> {
    this.searches.push(query);
    return answer(this.searchAnswer, signal);
  }

  async fetch(urls: string[], signal: AbortSignal): Promise<FetchOutcome> {
    this.fetches.push(urls);
    return answer(this.fetchAnswer, signal);
  }

  async verify(signal: AbortSignal): Promise<void> {
    return answer(this.verifyAnswer, signal);
  }
}

export const hit = (url: string, title = url) => ({ title, url, snippet: `sobre ${title}`, date: null });
