import type { Conversation } from '../domain/conversation';
import { appError } from '../domain/error';
import { ANTHROPIC_PROVIDER, type ConversationId } from '../domain/ids';
import type { Message } from '../domain/message';
import type { Model } from '../domain/model';
import type { ChatProvider } from '../ports/chat-provider';
import type { CredentialStore } from '../ports/credential-store';
import type { SettingsStore } from '../ports/settings-store';
import { connect, disconnect } from './connect';
import {
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

export interface ToiDeps extends Omit<FlowDeps, 'provider' | 'onUpdate'> {
  credentials: CredentialStore;
  settings: SettingsStore;
  createProvider: (apiKey: string) => ChatProvider;
}

/**
 * Fachada da camada app. Esconde a lifecycle da Chave, a criação do Provedor,
 * a recuperação na abertura e a composição de "apagar tudo". A UI depende só
 * desta interface; `main.tsx` injeta o adaptador concreto.
 *
 * `flow` é estável: trocar a Chave troca o Provedor por dentro. Sem Chave,
 * `send`/`retry` recusam com `not_connected`.
 */
export interface Toi {
  readonly flow: Flow;
  connected(): boolean;
  /** Cada Mensagem que esta aba grava ou recebe em Fluxo. Devolve o cancelamento. */
  subscribe(listener: (message: Message) => void): () => void;
  /** Cache de Modelos da Chave atual; `null` antes da primeira listagem. */
  models(): Promise<Model[] | null>;
  refreshModels(signal?: AbortSignal): Promise<Model[]>;
  /** Default de uma Conversa nova. */
  lastModel(): Promise<string | null>;
  /** Troca o Modelo da Conversa e passa a ser o default das próximas. */
  changeModel(id: ConversationId, model: string): Promise<Conversation | null>;
  listConversations(): Promise<Conversation[]>;
  /** Histórico gravado, também por outra aba; ver `ConversationStore`. */
  watchConversations(listener: (conversations: Conversation[]) => void): () => void;
  watchMessages(conversationId: ConversationId, listener: (messages: Message[]) => void): () => void;
  listMessages(conversationId: ConversationId): Promise<Message[]>;
  /** O Modelo escolhido vira o default das próximas. */
  createConversation(model: string): Promise<Conversation>;
  renameConversation(id: ConversationId, title: string): Promise<Conversation | null>;
  deleteConversation(id: ConversationId): Promise<void>;
  connect(apiKey: string, signal?: AbortSignal): Promise<Model[]>;
  disconnect(): Promise<void>;
  eraseConversations(): Promise<void>;
  eraseAll(): Promise<void>;
  /** Retrato do histórico no formato versionado de `app/export.ts`; nunca inclui a Chave. */
  exportHistory(): Promise<HistoryExport>;
}

export const createToi = async (deps: ToiDeps): Promise<Toi> => {
  let provider: ChatProvider | null = null;
  const listeners = new Set<(message: Message) => void>();

  const flow = createFlow({
    ...deps,
    provider: () => provider,
    onUpdate: (message) => {
      for (const listener of listeners) listener(message);
    },
  });

  // O cache só evita uma listagem na abertura; falhar ao gravá-lo não desfaz a conexão.
  const cacheModels = (models: Model[]): Promise<void> =>
    deps.settings.saveModels(models).catch(() => undefined);

  const [savedKey] = await Promise.all([
    deps.credentials.get(ANTHROPIC_PROVIDER),
    recoverInterrupted(deps),
  ]);
  if (savedKey) provider = deps.createProvider(savedKey);

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
    connected: () => provider !== null,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    models: () => deps.settings.models(),

    async refreshModels(signal = new AbortController().signal) {
      if (provider === null) throw appError('not_connected');

      const models = await provider.listModels(signal);
      await cacheModels(models);
      return models;
    },

    lastModel: () => deps.settings.lastModel(),

    async changeModel(id, model) {
      const [updated] = await Promise.all([
        changeModel(deps, id, model),
        deps.settings.saveLastModel(model),
      ]);
      return updated;
    },

    listConversations: () => deps.store.listConversations(),
    watchConversations: (listener) => deps.store.watchConversations(listener),
    watchMessages: (conversationId, listener) => deps.store.watchMessages(conversationId, listener),
    listMessages: (conversationId) => deps.store.listMessages(conversationId),
    async createConversation(model) {
      const [conversation] = await Promise.all([
        createConversation(deps, model),
        deps.settings.saveLastModel(model),
      ]);
      return conversation;
    },
    renameConversation: (id, title) => renameConversation(deps, id, title),

    deleteConversation: (id) => guarded(() => deleteConversation(deps, id), id),

    async connect(apiKey, signal) {
      const connected = await connect(deps, apiKey, signal);

      provider = connected.provider;
      await cacheModels(connected.models);
      return connected.models;
    },

    disconnect: () =>
      flow.exclusive(async () => {
        await disconnect(deps);
        provider = null;
      }),

    eraseConversations: () => guarded(() => eraseConversations(deps.store)),

    eraseAll: () =>
      guarded(async () => {
        try {
          await eraseAll(deps);
        } finally {
          // Falha parcial ainda desconecta: "apagar tudo" erra para o lado da Chave fora.
          provider = null;
        }
      }),

    exportHistory: () => exportHistory(deps),
  };
};
