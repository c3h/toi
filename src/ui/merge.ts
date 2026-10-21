import type { Message } from '../domain/message';

/**
 * Junta o que o store tem com o que o Fluxo desta aba já recebeu. O store só
 * vê o Fluxo a cada flush, então a cópia local vence enquanto um dos dois
 * ainda estiver `streaming`. Fechados os dois, o store volta a valer — outra
 * aba pode tentar de novo depois — e a cópia local sai de `live`.
 */
export const mergeMessages = (stored: Message[], live: Map<string, Message>): Message[] => {
  const merged = new Map(stored.map((message) => [message.id, message]));

  for (const [id, local] of live) {
    const persisted = merged.get(id);

    if (persisted && persisted.status !== 'streaming' && local.status !== 'streaming') {
      live.delete(id);
    } else {
      merged.set(id, local);
    }
  }

  return [...merged.values()].sort((a, b) => a.seq - b.seq);
};

/**
 * Reaproveita o objeto anterior de cada Mensagem fechada que não mudou: o
 * store entrega objetos novos a cada flush, e sem isso o `memo` de cada
 * Mensagem nunca acerta. Só a última do assistant muda depois de fechada, e
 * ao tentar de novo ela passa por `streaming` e troca `completedAt`.
 */
export const keepUnchanged = (previous: Message[], next: Message[]): Message[] => {
  const before = new Map(previous.map((message) => [message.id, message]));

  return next.map((message) => {
    const old = before.get(message.id);
    return old &&
      old.status !== 'streaming' &&
      old.status === message.status &&
      old.completedAt === message.completedAt
      ? old
      : message;
  });
};
