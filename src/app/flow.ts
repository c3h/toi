import { appError } from '../domain/error';
import type { ConversationId, ProviderId } from '../domain/ids';
import type { ChatProvider } from '../ports/chat-provider';
import type { Locks } from '../ports/locks';
import type { WebTools } from '../ports/web-tools';
import { conversationWriteLocks, withLocks } from './locks';
import {
  startRetryMessage,
  startSendMessage,
  type MessageRun,
  type RetryOptions,
  type RunDeps,
  type RunResult,
  type SendOptions,
} from './send-message';

export interface Flow {
  send(options: Omit<SendOptions, 'signal'>): Promise<RunResult>;
  retry(options: Omit<RetryOptions, 'signal'>): Promise<RunResult>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  /** Conversa com Fluxo em voo, ou `null`. */
  active(): ConversationId | null;
}

/** Controle do app sobre o Fluxo; a UI recebe só `Flow`. */
export interface FlowControl extends Flow {
  /**
   * Para o Fluxo e recusa novos enquanto `task` roda. Com `conversationId`,
   * para e bloqueia só aquela Conversa.
   */
  exclusive<T>(task: () => Promise<T>, conversationId?: ConversationId): Promise<T>;
}

export interface FlowDeps extends Omit<RunDeps, 'provider' | 'tools'> {
  /** Provedor conectado, lido a cada `send`/`retry`; `null` sem Chave para ele. */
  provider: (id: ProviderId) => ChatProvider | null;
  /** Serviço das Ferramentas, lido a cada `send`/`retry`; `null` sem Chave. */
  tools: () => WebTools | null;
  /** Um Fluxo por Conversa também entre abas; ver `app/locks.ts`. */
  locks: Locks;
}

interface InFlight {
  conversationId: ConversationId;
  controller: AbortController;
  run: MessageRun | null;
  result: Promise<RunResult> | null;
}

/** Bloqueio de `exclusive` dentro da aba; `null` bloqueia todas as Conversas. */
interface Exclusion {
  conversationId: ConversationId | null;
}

export const createFlow = (deps: FlowDeps): FlowControl => {
  const { provider: currentProvider, tools: currentTools, locks, ...runDeps } = deps;
  const exclusions = new Set<Exclusion>();
  let current: InFlight | null = null;

  const excluded = (conversationId: ConversationId): boolean =>
    [...exclusions].some(
      (exclusion) => exclusion.conversationId === null || exclusion.conversationId === conversationId,
    );

  const start = (
    conversationId: ConversationId,
    providerId: ProviderId,
    launch: (deps: RunDeps, signal: AbortSignal) => Promise<MessageRun>,
  ): Promise<RunResult> => {
    if (current !== null || excluded(conversationId)) {
      return Promise.reject(appError('flow_busy'));
    }

    // Capturados uma vez: o Fluxo em voo nunca troca de Provedor nem de Serviço.
    const provider = currentProvider(providerId);
    if (provider === null) return Promise.reject(appError('not_connected'));
    const tools = currentTools();

    const flight: InFlight = {
      conversationId,
      controller: new AbortController(),
      run: null,
      result: null,
    };
    current = flight;

    flight.result = (async () => {
      try {
        // O lock cobre ler o `seq`, gravar e o Fluxo inteiro; outra aba recebe `flow_busy`.
        return await withLocks(locks, conversationWriteLocks(conversationId), async () => {
          flight.run = await launch({ ...runDeps, provider, tools }, flight.controller.signal);
          return await flight.run.result;
        });
      } finally {
        if (current === flight) current = null;
      }
    })();

    return flight.result;
  };

  const stop = async (): Promise<void> => {
    const flight = current;
    if (flight === null) return;

    flight.controller.abort();
    await flight.result?.catch(() => undefined);
  };

  return {
    send: (options) =>
      start(options.conversationId, options.model.provider, (run, signal) =>
        startSendMessage(run, { ...options, signal }),
      ),
    retry: (options) =>
      start(options.conversationId, options.model.provider, (run, signal) =>
        startRetryMessage(run, { ...options, signal }),
      ),
    stop,
    flush: () => current?.run?.flush() ?? Promise.resolve(),
    active: () => current?.conversationId ?? null,

    async exclusive(task, conversationId) {
      const exclusion: Exclusion = { conversationId: conversationId ?? null };
      exclusions.add(exclusion);

      try {
        if (conversationId === undefined || current?.conversationId === conversationId) {
          await stop();
        }
        return await task();
      } finally {
        exclusions.delete(exclusion);
      }
    },
  };
};
