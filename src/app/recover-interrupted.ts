import { closeMessage, type Message } from '../domain/message';
import type { ConversationStore } from '../ports/conversation-store';

export const DEFAULT_LEASE_MS = 15_000;

export const recoverInterrupted = async (
  store: ConversationStore,
  now: number,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<Message[]> => {
  const streaming = await store.listStreamingMessages();
  const recovered: Message[] = [];

  for (const message of streaming) {
    if (message.stream && now - message.stream.heartbeatAt < leaseMs) continue;

    const interrupted = closeMessage(message, 'interrupted', now);

    await store.putMessage(interrupted);
    recovered.push(interrupted);
  }

  return recovered;
};
