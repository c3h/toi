import { AppError } from '../domain/error';
import { isLeaseExpired, closeMessage, type Message } from '../domain/message';
import type { Clock } from '../ports/clock';
import type { ConversationStore } from '../ports/conversation-store';
import type { Locks } from '../ports/locks';
import { conversationWriteLocks, withLocks } from './locks';

export interface RecoverDeps {
  store: ConversationStore;
  clock: Clock;
  locks: Locks;
}

const interrupt = async (deps: RecoverDeps, message: Message): Promise<Message> => {
  const closed = closeMessage(message, 'interrupted', deps.clock.now());
  await deps.store.putMessage(closed);
  return closed;
};

/**
 * Com Web Locks, quem grava uma Mensagem `streaming` segura o lock da Conversa:
 * conseguir o lock prova que o dono morreu. A Mensagem é relida sob o lock porque
 * o Fluxo pode ter fechado entre a listagem e a aquisição.
 */
const recoverByLock = async (deps: RecoverDeps, message: Message): Promise<Message | null> => {
  try {
    return await withLocks(deps.locks, conversationWriteLocks(message.conversationId), async () => {
      const current = await deps.store.getMessage(message.id);
      return current?.status === 'streaming' ? interrupt(deps, current) : null;
    });
  } catch (error) {
    // Lock ocupado: o dono está vivo ou o histórico está sendo apagado.
    if (error instanceof AppError && error.code === 'flow_busy') return null;
    throw error;
  }
};

/** Sem Web Locks, a liveness é o Lease do Fluxo. */
const recoverByLease = async (deps: RecoverDeps, message: Message): Promise<Message | null> =>
  isLeaseExpired(message.stream, deps.clock.now()) ? interrupt(deps, message) : null;

export const recoverInterrupted = async (deps: RecoverDeps): Promise<Message[]> => {
  const recovered: Message[] = [];

  // Em série: duas Mensagens da mesma Conversa disputariam o mesmo lock.
  for (const message of await deps.store.listStreamingMessages()) {
    const closed = deps.locks.crossTab
      ? await recoverByLock(deps, message)
      : await recoverByLease(deps, message);
    if (closed) recovered.push(closed);
  }

  return recovered;
};
