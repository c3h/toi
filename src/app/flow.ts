import { appError } from '../domain/error';
import type { ConversationId, ProviderId } from '../domain/ids';
import type { Message } from '../domain/message';
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

/** Os Fluxos desta aba, um por Conversa; Conversas diferentes respondem em paralelo. */
export interface Flow {
  send(options: Omit<SendOptions, 'signal'>): Promise<RunResult>;
  retry(options: Omit<RetryOptions, 'signal'>): Promise<RunResult>;
  /** Para o Fluxo da Conversa e espera a Mensagem fechar; sem Fluxo nela, não faz nada. */
  stop(conversationId: ConversationId): Promise<void>;
  /**
   * Grava o rascunho de todos os Fluxos, para `pagehide`. Não rejeita: o fim
   * de cada Fluxo grava de novo e devolve a falha em `persistError`.
   */
  flush(): Promise<void>;
  /** Conversas com Fluxo nesta aba. O mesmo objeto até um Fluxo começar ou terminar. */
  active(): ReadonlySet<ConversationId>;
  /** Avisa quando um Fluxo começa ou termina, nunca a cada Evento. Devolve o cancelamento. */
  watch(listener: () => void): () => void;
}

/** Controle do app sobre o Fluxo; a UI recebe só `Flow`. */
export interface FlowControl extends Flow {
  /**
   * Para os Fluxos e recusa novos enquanto `task` roda. Com `conversationId`,
   * para e bloqueia só aquela Conversa.
   */
  exclusive<T>(task: () => Promise<T>, conversationId?: ConversationId): Promise<T>;
  /**
   * As Mensagens gravadas, com a resposta desta aba que terminou sem o último
   * flush no lugar da gravada, até o próximo envio ou tentativa gravá-la.
   */
  withUnsaved(conversationId: ConversationId, messages: Message[]): Message[];
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
  controller: AbortController;
  run: MessageRun | null;
  /** Assenta com a Mensagem fechada e os locks soltos. */
  done: Promise<unknown>;
}

/** Bloqueio de `exclusive` dentro da aba; `null` bloqueia todas as Conversas. */
interface Exclusion {
  conversationId: ConversationId | null;
}

export const createFlow = (deps: FlowDeps): FlowControl => {
  const { provider: currentProvider, tools: currentTools, locks, ...runDeps } = deps;
  const exclusions = new Set<Exclusion>();
  const flights = new Map<ConversationId, InFlight>();
  const listeners = new Set<() => void>();
  let active: ReadonlySet<ConversationId> = new Set();
  // Resposta que terminou sem o último flush, por Conversa: a única cópia inteira está aqui. Uma
  // só: o envio seguinte a grava antes de começar, ou recusa.
  const unsaved = new Map<ConversationId, Message>();

  const publish = (): void => {
    active = new Set(flights.keys());
    for (const listener of listeners) listener();
  };

  const excluded = (conversationId: ConversationId): boolean =>
    [...exclusions].some(
      (exclusion) => exclusion.conversationId === null || exclusion.conversationId === conversationId,
    );

  /** Aborta todos antes de esperar qualquer um: parar dois Fluxos não custa a soma deles. */
  const halt = async (targets: InFlight[]): Promise<void> => {
    for (const flight of targets) flight.controller.abort();
    await Promise.all(targets.map((flight) => flight.done));
  };

  const retain = ({ message, persistError }: RunResult): void => {
    if (persistError !== null) unsaved.set(message.conversationId, message);
  };

  /**
   * Grava as respostas retidas da Conversa antes da próxima escrita nela, sob o
   * lock: o envio e a nova tentativa leem o histórico que a pessoa vê.
   */
  const saveUnsaved = async (conversationId: ConversationId): Promise<void> => {
    const kept = unsaved.get(conversationId);
    if (kept === undefined) return;

    try {
      await runDeps.store.putMessage(kept);
    } catch (cause) {
      throw appError('storage_failed', { cause });
    }
    unsaved.delete(conversationId);
  };

  const inFlight = (conversationId?: ConversationId): InFlight[] => {
    if (conversationId === undefined) return [...flights.values()];
    const flight = flights.get(conversationId);
    return flight ? [flight] : [];
  };

  const start = (
    conversationId: ConversationId,
    providerId: ProviderId,
    launch: (deps: RunDeps, signal: AbortSignal) => Promise<MessageRun>,
  ): Promise<RunResult> => {
    if (flights.has(conversationId) || excluded(conversationId)) {
      return Promise.reject(appError('flow_busy'));
    }

    // Capturados uma vez: o Fluxo em voo nunca troca de Provedor nem de Serviço.
    const provider = currentProvider(providerId);
    if (provider === null) return Promise.reject(appError('not_connected'));
    const tools = currentTools();

    const flight: InFlight = {
      controller: new AbortController(),
      run: null,
      done: Promise.resolve(),
    };

    const result = (async () => {
      try {
        // O lock cobre ler o `seq`, gravar e o Fluxo inteiro; outra aba recebe `flow_busy`.
        return await withLocks(locks, conversationWriteLocks(conversationId), async () => {
          await saveUnsaved(conversationId);
          flight.run = await launch({ ...runDeps, provider, tools }, flight.controller.signal);
          const result = await flight.run.result;
          retain(result);
          return result;
        });
      } finally {
        flights.delete(conversationId);
        publish();
      }
    })();

    // Publicado só com `done` no lugar: quem ouve pode parar o Fluxo na hora.
    flight.done = result.catch(() => undefined);
    flights.set(conversationId, flight);
    publish();

    return result;
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
    stop: (conversationId) => halt(inFlight(conversationId)),
    async flush() {
      await Promise.allSettled([...flights.values()].map((flight) => flight.run?.flush()));
    },
    active: () => active,
    watch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async exclusive(task, conversationId) {
      const exclusion: Exclusion = { conversationId: conversationId ?? null };
      exclusions.add(exclusion);

      try {
        await halt(inFlight(conversationId));
        return await task();
      } finally {
        exclusions.delete(exclusion);
      }
    },

    // Só substitui: `startTurn` grava a Mensagem antes do Fluxo, e apagada a Conversa, não sobra
    // linha para a cópia voltar à tela.
    withUnsaved(conversationId, messages) {
      const kept = unsaved.get(conversationId);
      if (kept === undefined) return messages;
      return messages.map((message) => (message.id === kept.id ? kept : message));
    },
  };
};
