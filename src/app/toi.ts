import type { Conversation } from '../domain/conversation';
import { appError } from '../domain/error';
import type { AttachmentId, ConversationId, ProviderId } from '../domain/ids';
import { MAX_INSTRUCTIONS_CHARS, normalizeInstructions } from '../domain/instructions';
import type { Message } from '../domain/message';
import {
  pickedModels,
  titleModelOf,
  type Effort,
  type FamilyRef,
  type Model,
  type ModelPicks,
  type ModelRef,
} from '../domain/model';
import type { ToolSpace } from '../domain/web';
import type { ChatProvider, ProviderAdapter, ProviderInfo } from '../ports/chat-provider';
import type { CredentialStore } from '../ports/credential-store';
import type { SettingsStore } from '../ports/settings-store';
import type { ServiceAdapter, ServiceInfo, WebTools } from '../ports/web-tools';
import { changeEffort, changeModel, createConversation, renameConversation } from './conversations';
import { exportHistory } from './export';
import { createFlow, type Flow, type FlowDeps } from './flow';
import { conversationWriteLocks, historyEraseLocks, withLocks } from './locks';
import { firstExchange, nameConversation, type FirstExchange } from './name-conversation';
import { recoverInterrupted } from './recover-interrupted';
import { readToolSpace } from './web-tools';

export type { ProviderInfo, ServiceInfo };

export interface ToiDeps extends Omit<FlowDeps, 'provider' | 'tools' | 'onUpdate'> {
  credentials: CredentialStore;
  settings: SettingsStore;
  /** Provedores registrados em `main.tsx`, na ordem em que a UI os oferece. */
  providers: ProviderAdapter[];
  /** O Serviço das Ferramentas; um só, até haver decisão por um segundo. */
  service: ServiceAdapter;
}

/**
 * Fachada da camada app. Esconde a lifecycle das Chaves, a criação dos
 * Provedores, a recuperação na abertura e a composição de "apagar tudo". A UI
 * depende só desta interface; `main.tsx` injeta os adaptadores concretos.
 *
 * `flow` é estável: trocar uma Chave troca o Provedor por dentro. Sem Chave
 * para o Provedor do Modelo, `send`/`retry` recusam com `not_connected`. Com
 * Chave do Serviço, o envio oferece as Ferramentas dele; sem, não oferece.
 *
 * Quando a primeira resposta de uma Conversa termina `complete`, a aba que a
 * enviou pede o Título ao Modelo do Título, fora do Fluxo e do lock da
 * Conversa; ver `app/name-conversation.ts`.
 */
export interface Toi {
  readonly flow: Flow;
  /** O que a UI mostra de cada Provedor registrado; nunca endpoint ou Protocolo. */
  providers(): ProviderInfo[];
  /** Há Chave para pelo menos um Provedor. A Chave do Serviço não conta: sozinha ela não conversa. */
  connected(): boolean;
  /** O que a UI mostra do Serviço; nunca endpoint. */
  service(): ServiceInfo;
  serviceConnected(): boolean;
  /**
   * Valida e grava a Chave do Serviço. Recusada, ou sem dar para validar agora
   * (cota, limite por minuto, rede), recusa com o erro e a anterior fica.
   */
  connectService(apiKey: string, signal: AbortSignal): Promise<void>;
  /** Para os Fluxos em voo, que usam a Chave, e a remove. */
  disconnectService(): Promise<void>;
  /** Cada Mensagem que esta aba grava ou recebe em Fluxo. Devolve o cancelamento. */
  subscribe(listener: (message: Message) => void): () => void;
  /** Cache de Modelos dos Provedores conectados; `null` sem conexão ou se falta a listagem de algum. */
  models(): Promise<Model[] | null>;
  /** Lista de novo em todos os Provedores conectados; a lista de uma Chave que saiu no meio não grava o cache. */
  refreshModels(signal: AbortSignal): Promise<Model[]>;
  /** Default de uma Conversa nova. */
  lastModel(): Promise<ModelRef | null>;
  /** Default de uma Conversa nova; `null` até a pessoa escolher um. */
  lastEffort(): Promise<Effort | null>;
  /** O que o seletor oferece; `defaultModelPicks` até a pessoa mexer na lista. */
  modelPicks(): Promise<ModelPicks>;
  /** As famílias que cada Provedor registrado sugere. */
  defaultModelPicks(): ModelPicks;
  saveModelPicks(picks: ModelPicks): Promise<void>;
  /** Quanto as Rodadas de uma resposta podem ocupar; `DEFAULT_TOOL_SPACE` até a pessoa escolher. */
  toolSpace(): Promise<ToolSpace>;
  /** Vale a partir do próximo envio, também em outra aba. */
  saveToolSpace(space: ToolSpace): Promise<void>;
  /** A escolha gravada; `null` até a pessoa escolher, e então vale a família de `titleFamilies`. */
  titleModel(): Promise<ModelRef | null>;
  /** A família que cada Provedor registrado sugere para o Título. */
  titleFamilies(): FamilyRef[];
  /** Vale a partir da próxima Conversa nomeada, também em outra aba. */
  saveTitleModel(model: ModelRef): Promise<void>;
  /** As gravadas; `null` até a pessoa escrever. */
  instructions(): Promise<string | null>;
  /**
   * Grava normalizadas (`normalizeInstructions`): vazias apagam. Vale a partir
   * do próximo envio, também em outra aba; a resposta em curso segue com as
   * que leu. Recusa texto acima de `MAX_INSTRUCTIONS_CHARS`.
   */
  saveInstructions(text: string): Promise<void>;
  /** Troca o Modelo da Conversa e passa a ser o default das próximas. */
  changeModel(id: ConversationId, model: ModelRef): Promise<Conversation | null>;
  /** Troca o Esforço da Conversa e passa a ser o default das próximas. */
  changeEffort(id: ConversationId, effort: Effort): Promise<Conversation | null>;
  /** Histórico gravado, também por outra aba; ver `ConversationStore`. */
  watchConversations(listener: (conversations: Conversation[]) => void): () => void;
  /**
   * Mensagens gravadas, também por outra aba. Uma resposta desta aba que
   * terminou sem o último flush aparece inteira até ser gravada, o que o
   * próximo envio ou a próxima tentativa na Conversa tentam antes de escrever.
   */
  watchMessages(conversationId: ConversationId, listener: (messages: Message[]) => void): () => void;
  /** O envio que a segue grava Modelo e Esforço como default das próximas. */
  createConversation(model: ModelRef, effort: Effort): Promise<Conversation>;
  renameConversation(id: ConversationId, title: string): Promise<Conversation | null>;
  deleteConversation(id: ConversationId): Promise<void>;
  /** Valida e grava a Chave; devolve os Modelos de todos os Provedores conectados. */
  connect(provider: ProviderId, apiKey: string, signal: AbortSignal): Promise<Model[]>;
  disconnect(provider: ProviderId): Promise<void>;
  eraseConversations(): Promise<void>;
  eraseAll(): Promise<void>;
  /** Os bytes de um Anexo, para a UI mostrar ou baixar. */
  attachment(id: AttachmentId): Promise<Blob>;
  /** Arquivo JSON do histórico no formato versionado de `app/export.ts`; nunca inclui a Chave. */
  exportHistory(): Promise<Blob>;
}

/** Título pedido depois da primeira resposta; `provider` é `null` até escolher o Modelo do Título. */
interface Naming {
  provider: ProviderId | null;
  controller: AbortController;
}

export const createToi = async (deps: ToiDeps): Promise<Toi> => {
  const infos = deps.providers.map((adapter) => adapter.info);
  const adapters = new Map(deps.providers.map((adapter) => [adapter.info.id, adapter]));
  const connections = new Map<ProviderId, ChatProvider>();
  const serviceId = deps.service.info.id;
  // As Ferramentas da Chave gravada; `null` sem ela.
  let tools: WebTools | null = null;
  const listeners = new Set<(message: Message) => void>();

  const control = createFlow({
    ...deps,
    provider: (id) => connections.get(id) ?? null,
    tools: () => tools,
    onUpdate: (message) => {
      for (const listener of listeners) listener(message);
    },
  });

  // O cache só evita uma listagem na abertura; falhar ao gravá-lo não desfaz a conexão.
  const cacheModels = (provider: ProviderId, models: Model[]): Promise<void> =>
    deps.settings.saveModels(provider, models).catch(() => undefined);

  const readCachedModels = (providers: ProviderId[]): Promise<Array<Model[] | null>> =>
    Promise.all(providers.map((id) => deps.settings.models(id)));

  const defaultPicks: ModelPicks = {
    families: deps.providers.flatMap(({ info }) =>
      info.defaultFamilies.map((name) => ({ provider: info.id, name })),
    ),
    models: [],
  };

  await Promise.all([
    ...deps.providers.map(async (adapter) => {
      const key = await deps.credentials.get(adapter.info.id);
      if (key) connections.set(adapter.info.id, adapter.create(key));
    }),
    // Sem revalidar na abertura: uma Chave recusada aparece na primeira chamada.
    deps.credentials.get(serviceId).then((key) => {
      if (key) tools = deps.service.create(key);
    }),
    recoverInterrupted(deps),
  ]);

  const titleFamilies: FamilyRef[] = deps.providers.map(({ info }) => ({
    provider: info.id,
    name: info.titleFamily,
  }));

  // Uma tentativa de Título por Conversa, cancelada quando a Conversa ou a Chave sai. Registrada
  // antes de escolher o Modelo (`provider` ainda `null`), para apagar no meio também cancelar.
  const naming = new Map<ConversationId, Naming>();

  const stopNaming = (
    matches: (id: ConversationId, provider: ProviderId | null) => boolean,
  ): void => {
    for (const [id, task] of naming) {
      if (!matches(id, task.provider)) continue;
      task.controller.abort();
      naming.delete(id);
    }
  };

  const modelPicks = async (): Promise<ModelPicks> =>
    (await deps.settings.modelPicks()) ?? defaultPicks;

  const cachedModels = async (): Promise<Model[] | null> => {
    if (connections.size === 0) return null;
    const lists = await readCachedModels([...connections.keys()]);
    return lists.every((list): list is Model[] => list !== null) ? lists.flat() : null;
  };

  /** O Modelo do Título entre os do seletor; `null` quando ele saiu de lá. */
  const resolveTitleModel = async (): Promise<Model | null> => {
    const [models, picks, saved] = await Promise.all([
      cachedModels(),
      modelPicks(),
      deps.settings.titleModel(),
    ]);
    return models === null ? null : titleModelOf(pickedModels(models, picks), saved, titleFamilies);
  };

  /** Sem Modelo do Título, sem Chave ou com qualquer falha, fica o Título derivado. */
  const requestTitle = async (exchange: FirstExchange) => {
    const { conversationId } = exchange;
    const task: Naming = { provider: null, controller: new AbortController() };
    naming.set(conversationId, task);

    try {
      const model = await resolveTitleModel().catch(() => null);
      const provider = model === null ? undefined : connections.get(model.provider);
      if (model === null || provider === undefined || task.controller.signal.aborted) return;

      task.provider = model.provider;
      await nameConversation(deps.store, provider, model, exchange, task.controller.signal);
    } finally {
      if (naming.get(conversationId) === task) naming.delete(conversationId);
    }
  };

  const flow: Flow = {
    ...control,
    async send(options) {
      const result = await control.send(options);
      const exchange = firstExchange(result);
      if (exchange !== null) void requestTitle(exchange);
      return result;
    },
  };

  /**
   * Para os Fluxos desta aba e segura os locks entre abas. Com `conversationId`,
   * só aquela Conversa; sem, o histórico inteiro.
   */
  const guarded = <T>(task: () => Promise<T>, conversationId?: ConversationId): Promise<T> =>
    control.exclusive(
      () =>
        withLocks(
          deps.locks,
          conversationId === undefined ? historyEraseLocks : conversationWriteLocks(conversationId),
          task,
        ),
      conversationId,
    );

  return {
    flow,
    providers: () => infos,
    connected: () => connections.size > 0,
    service: () => deps.service.info,
    serviceConnected: () => tools !== null,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    models: cachedModels,

    async refreshModels(signal) {
      if (connections.size === 0) throw appError('not_connected');

      const lists = await Promise.all(
        [...connections].map(async ([id, provider]) => {
          const models = await provider.listModels(signal);
          // A Chave trocou ou saiu durante a listagem: a lista dela não grava por cima da atual.
          if (connections.get(id) !== provider) {
            throw new DOMException('A Chave mudou durante a listagem.', 'AbortError');
          }
          await cacheModels(id, models);
          return models;
        }),
      );
      return lists.flat();
    },

    lastModel: () => deps.settings.lastModel(),
    lastEffort: () => deps.settings.lastEffort(),

    modelPicks,

    defaultModelPicks: () => defaultPicks,

    saveModelPicks: (picks) => deps.settings.saveModelPicks(picks),

    toolSpace: () => readToolSpace(deps.settings),

    saveToolSpace: (space) => deps.settings.saveToolSpace(space),

    titleModel: () => deps.settings.titleModel(),

    titleFamilies: () => titleFamilies,

    saveTitleModel: (model) => deps.settings.saveTitleModel(model),

    instructions: () => deps.settings.instructions(),

    async saveInstructions(text) {
      const instructions = normalizeInstructions(text);
      if (instructions !== null && instructions.length > MAX_INSTRUCTIONS_CHARS) {
        throw new Error(`saveInstructions recebeu mais de ${MAX_INSTRUCTIONS_CHARS} caracteres.`);
      }
      await deps.settings.saveInstructions(instructions);
    },

    async changeModel(id, model) {
      const [updated] = await Promise.all([
        changeModel(deps, id, model),
        deps.settings.saveLastModel(model),
      ]);
      return updated;
    },

    async changeEffort(id, effort) {
      const [updated] = await Promise.all([
        changeEffort(deps, id, effort),
        deps.settings.saveLastEffort(effort),
      ]);
      return updated;
    },

    watchConversations: (listener) => deps.store.watchConversations(listener),
    watchMessages: (conversationId, listener) =>
      deps.store.watchMessages(conversationId, (messages) =>
        listener(control.withUnsaved(conversationId, messages)),
      ),
    createConversation: (model, effort) => createConversation(deps, model, effort),
    renameConversation: (id, title) => renameConversation(deps, id, title),

    // O Título sai depois de o Fluxo parar, que pode ter terminado no meio.
    deleteConversation: (id) =>
      guarded(async () => {
        stopNaming((conversation) => conversation === id);
        await deps.store.deleteConversation(id);
      }, id),

    async connect(providerId, apiKey, signal) {
      const adapter = adapters.get(providerId);
      if (!adapter) throw new Error(`Provedor ${providerId} não registrado.`);

      const key = apiKey.trim();
      if (!key) throw appError('invalid_credential');

      // A Chave só é gravada depois que `listModels` a valida; se falha, a anterior fica.
      const provider = adapter.create(key);
      const models = await provider.listModels(signal);
      await deps.credentials.set(providerId, key);
      connections.set(providerId, provider);
      // O Título pendente usava a Chave anterior.
      stopNaming((_, owner) => owner === providerId);

      const others = [...connections.keys()].filter((id) => id !== providerId);
      const [, cached] = await Promise.all([
        cacheModels(providerId, models),
        readCachedModels(others),
      ]);
      return [...cached.flatMap((list) => list ?? []), ...models];
    },

    disconnect: (providerId) =>
      control.exclusive(async () => {
        // O Título que ainda escolhe o Modelo também sai: a escolha pode terminar antes da conexão.
        stopNaming((_, owner) => owner === providerId || owner === null);
        await deps.credentials.delete(providerId);
        connections.delete(providerId);
      }),

    async connectService(apiKey, signal) {
      const key = apiKey.trim();
      if (!key) throw appError('tool_invalid_credential');

      const candidate = deps.service.create(key);
      await candidate.verify(signal);
      // Desistir durante a validação vale mesmo se ela acabou de passar.
      signal.throwIfAborted();
      await deps.credentials.set(serviceId, key);
      tools = candidate;
    },

    // Outra aba com o Serviço segue usando a Chave até recarregar, como a do Provedor.
    disconnectService: () =>
      control.exclusive(async () => {
        await deps.credentials.delete(serviceId);
        tools = null;
      }),

    eraseConversations: () =>
      guarded(async () => {
        stopNaming(() => true);
        await deps.store.clearConversations();
      }),

    eraseAll: () =>
      guarded(async () => {
        stopNaming(() => true);
        try {
          // Conversas, Configurações e todas as Chaves, também as de Provedor que saiu do registro.
          await Promise.all([
            deps.store.clearConversations(),
            deps.settings.clear(),
            deps.credentials.clear(),
          ]);
        } finally {
          // Falha parcial ainda desconecta: "apagar tudo" erra para o lado da Chave fora.
          connections.clear();
          tools = null;
        }
      }),

    async attachment(id) {
      const [blob] = await deps.store.readAttachments([id]);
      return blob!;
    },

    exportHistory: () => exportHistory(deps),
  };
};
