import { AppError } from '../domain/error';
import { closeMessage, type Message } from '../domain/message';
import type { Clock } from '../ports/clock';
import type { ConversationStore } from '../ports/conversation-store';
import type { Locks } from '../ports/locks';
import { conversationWriteLocks, withLocks } from './locks';

export interface RecoverDeps {
  store: ConversationStore;
  clock: Clock;
  locks: Locks;
}

/**
 * Quem grava uma Mensagem `streaming` segura o lock da Conversa: conseguir o
 * lock prova que o dono morreu. A Mensagem é relida sob o lock porque o Fluxo
 * pode ter fechado entre a listagem e a aquisição.
 */
const recover = async (deps: RecoverDeps, message: Message): Promise<Message | null> => {
  try {
    return await withLocks(deps.locks, conversationWriteLocks(message.conversationId), async () => {
      const current = await deps.store.getMessage(message.id);
      if (current?.status !== 'streaming') return null;

      const closed = closeMessage(current, 'interrupted', deps.clock.now());
      await deps.store.putMessage(closed);
      return closed;
    });
  } catch (error) {
    // Lock ocupado: o dono está vivo ou o histórico está sendo apagado.
    if (error instanceof AppError && error.code === 'flow_busy') return null;
    throw error;
  }
};

export const recoverInterrupted = async (deps: RecoverDeps): Promise<Message[]> => {
  const recovered: Message[] = [];

  // Em série: duas Mensagens da mesma Conversa disputariam o mesmo lock.
  for (const message of await deps.store.listStreamingMessages()) {
    const closed = await recover(deps, message);
    if (closed) recovered.push(closed);
  }

  return recovered;
};
