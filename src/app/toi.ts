import type { Conversation } from '../domain/conversation';
import { appError } from '../domain/error';
import type { ConversationId, ProviderId } from '../domain/ids';
import type { Message } from '../domain/message';
import type { Effort, Model, ModelPicks, ModelRef } from '../domain/model';
import type { ChatProvider, ProviderAdapter, ProviderInfo } from '../ports/chat-provider';
import type { CredentialStore } from '../ports/credential-store';
import type { SettingsStore } from '../ports/settings-store';
import {
  changeEffort,
  changeModel,
  createConversation,
  deleteConversation,
  renameConversation,
} from './conversations';
import { eraseAll, eraseConversations } from './erase';
import { exportHistory, type HistoryExport } from './export';
import { createFlow, type Flow, type FlowDeps } from './flow';
import { conversationWriteLocks, historyEraseLocks, withLocks } from './locks';
import { recoverInterrupted } from './recover-interrupted';

export type { ProviderInfo };

export interface ToiDeps extends Omit<FlowDeps, 'provider' | 'onUpdate'> {
  credentials: CredentialStore;
  settings: SettingsStore;
  /** Provedores registrados em `main.tsx`, na ordem em que a UI os oferece. */
  providers: ProviderAdapter[];
}

/**
 * Fachada da camada app. Esconde a lifecycle das Chaves, a criação dos
 * Provedores, a recuperação na abertura e a composição de "apagar tudo". A UI
 * depende só desta interface; `main.tsx` injeta os adaptadores concretos.
 *
 * `flow` é estável: trocar uma Chave troca o Provedor por dentro. Sem Chave
 * para o Provedor do Modelo, `send`/`retry` recusam com `not_connected`.
 */
export interface Toi {
  readonly flow: Flow;
  /** O que a UI mostra de cada Provedor registrado; nunca endpoint ou Protocolo. */
  providers(): ProviderInfo[];
  /** Há Chave para pelo menos um Provedor. */
  connected(): boolean;
  /** Cada Mensagem que esta aba grava ou recebe em Fluxo. Devolve o cancelamento. */
  subscribe(listener: (message: Message) => void): () => void;
  /** Cache de Modelos dos Provedores conectados; `null` sem conexão ou se falta a listagem de algum. */
  models(): Promise<Model[] | null>;
  /** Lista de novo em todos os Provedores conectados. */
  refreshModels(signal?: AbortSignal): Promise<Model[]>;
  /** Default de uma Conversa nova. */
  lastModel(): Promise<ModelRef | null>;
  /** Default de uma Conversa nova; `null` até a pessoa escolher um. */
  lastEffort(): Promise<Effort | null>;
  /** O que o seletor oferece; `defaultModelPicks` até a pessoa mexer na lista. */
  modelPicks(): Promise<ModelPicks>;
  /** As famílias que cada Provedor registrado sugere. */
  defaultModelPicks(): ModelPicks;
  saveModelPicks(picks: ModelPicks): Promise<void>;
  /** Troca o Modelo da Conversa e passa a ser o default das próximas. */
  changeModel(id: ConversationId, model: ModelRef): Promise<Conversation | null>;
  /** Troca o Esforço da Conversa e passa a ser o default das próximas. */
  changeEffort(id: ConversationId, effort: Effort): Promise<Conversation | null>;
  listConversations(): Promise<Conversation[]>;
  /** Histórico gravado, também por outra aba; ver `ConversationStore`. */
  watchConversations(listener: (conversations: Conversation[]) => void): () => void;
  watchMessages(conversationId: ConversationId, listener: (messages: Message[]) => void): () => void;
  listMessages(conversationId: ConversationId): Promise<Message[]>;
  /** O envio que a segue grava Modelo e Esforço como default das próximas. */
  createConversation(model: ModelRef, effort: Effort): Promise<Conversation>;
  renameConversation(id: ConversationId, title: string): Promise<Conversation | null>;
  deleteConversation(id: ConversationId): Promise<void>;
  /** Valida e grava a Chave; devolve os Modelos de todos os Provedores conectados. */
  connect(provider: ProviderId, apiKey: string, signal?: AbortSignal): Promise<Model[]>;
  disconnect(provider: ProviderId): Promise<void>;
  eraseConversations(): Promise<void>;
  eraseAll(): Promise<void>;
  /** Retrato do histórico no formato versionado de `app/export.ts`; nunca inclui a Chave. */
  exportHistory(): Promise<HistoryExport>;
}

export const createToi = async (deps: ToiDeps): Promise<Toi> => {
  const infos = deps.providers.map((adapter) => adapter.info);
  const adapters = new Map(deps.providers.map((adapter) => [adapter.info.id, adapter]));
  const connections = new Map<ProviderId, ChatProvider>();
  const listeners = new Set<(message: Message) => void>();

  const flow = createFlow({
    ...deps,
    provider: (id) => connections.get(id) ?? null,
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
    recoverInterrupted(deps),
  ]);

  /**
   * Para o Fluxo desta aba e segura os locks entre abas. Com `conversationId`,
   * só aquela Conversa; sem, o histórico inteiro.
   */
  const guarded = <T>(task: () => Promise<T>, conversationId?: ConversationId): Promise<T> =>
    flow.exclusive(
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

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async models() {
      if (connections.size === 0) return null;
      const lists = await readCachedModels([...connections.keys()]);
      return lists.every((list): list is Model[] => list !== null) ? lists.flat() : null;
    },

    async refreshModels(signal = new AbortController().signal) {
      if (connections.size === 0) throw appError('not_connected');

      const lists = await Promise.all(
        [...connections].map(async ([id, provider]) => {
          const models = await provider.listModels(signal);
          await cacheModels(id, models);
          return models;
        }),
      );
      return lists.flat();
    },

    lastModel: () => deps.settings.lastModel(),
    lastEffort: () => deps.settings.lastEffort(),

    async modelPicks() {
      return (await deps.settings.modelPicks()) ?? defaultPicks;
    },

    defaultModelPicks: () => defaultPicks,

    saveModelPicks: (picks) => deps.settings.saveModelPicks(picks),

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

    listConversations: () => deps.store.listConversations(),
    watchConversations: (listener) => deps.store.watchConversations(listener),
    watchMessages: (conversationId, listener) => deps.store.watchMessages(conversationId, listener),
    listMessages: (conversationId) => deps.store.listMessages(conversationId),
    createConversation: (model, effort) => createConversation(deps, model, effort),
    renameConversation: (id, title) => renameConversation(deps, id, title),

    deleteConversation: (id) => guarded(() => deleteConversation(deps, id), id),

    async connect(providerId, apiKey, signal = new AbortController().signal) {
      const adapter = adapters.get(providerId);
      if (!adapter) throw new Error(`Provedor ${providerId} não registrado.`);

      const key = apiKey.trim();
      if (!key) throw appError('invalid_credential');

      // A Chave só é gravada depois que `listModels` a valida; se falha, a anterior fica.
      const provider = adapter.create(key);
      const models = await provider.listModels(signal);
      await deps.credentials.set(providerId, key);
      connections.set(providerId, provider);

      const others = [...connections.keys()].filter((id) => id !== providerId);
      const [, cached] = await Promise.all([
        cacheModels(providerId, models),
        readCachedModels(others).catch(() => []),
      ]);
      return [...cached.flatMap((list) => list ?? []), ...models];
    },

    disconnect: (providerId) =>
      flow.exclusive(async () => {
        await deps.credentials.delete(providerId);
        connections.delete(providerId);
      }),

    eraseConversations: () => guarded(() => eraseConversations(deps.store)),

    eraseAll: () =>
      guarded(async () => {
        try {
          await eraseAll(deps);
        } finally {
          // Falha parcial ainda desconecta: "apagar tudo" erra para o lado da Chave fora.
          connections.clear();
        }
      }),

    exportHistory: () => exportHistory(deps),
  };
};
