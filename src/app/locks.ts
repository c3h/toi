import { appError } from '../domain/error';
import type { ConversationId } from '../domain/ids';
import type { LockMode, Locks, Release } from '../ports/locks';

/** Shared para quem escreve numa Conversa; exclusive para apagar o histórico. */
export const HISTORY_LOCK = 'toi:history';

/** Exclusive para quem escreve Mensagens na Conversa: um Fluxo por Conversa entre abas. */
export const conversationLock = (id: ConversationId): string => `toi:conversation:${id}`;

export interface LockRequest {
  name: string;
  mode: LockMode;
}

/**
 * Segura todos os locks, na ordem, enquanto `task` roda. Não espera: se
 * algum estiver com outro dono, solta os já obtidos e recusa com `flow_busy`.
 */
export const withLocks = async <T>(
  locks: Locks,
  requests: LockRequest[],
  task: () => Promise<T>,
): Promise<T> => {
  const releases: Release[] = [];

  try {
    for (const { name, mode } of requests) {
      const release = await locks.tryAcquire(name, mode);
      if (release === null) throw appError('flow_busy');
      releases.push(release);
    }

    return await task();
  } finally {
    for (const release of releases.reverse()) await release();
  }
};

/** Enviar, tentar de novo e apagar uma Conversa. */
export const conversationWriteLocks = (id: ConversationId): LockRequest[] => [
  { name: HISTORY_LOCK, mode: 'shared' },
  { name: conversationLock(id), mode: 'exclusive' },
];

/** Apagar Conversas e apagar tudo. */
export const historyEraseLocks: LockRequest[] = [{ name: HISTORY_LOCK, mode: 'exclusive' }];
