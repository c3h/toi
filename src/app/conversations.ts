import { MAX_TITLE_LENGTH, normalizeTitle, type Conversation } from '../domain/conversation';
import type { ConversationId } from '../domain/ids';
import type { Clock } from '../ports/clock';
import type { ConversationStore } from '../ports/conversation-store';

export interface ConversationDeps {
  store: ConversationStore;
  clock: Clock;
  newId: () => string;
}

export const createConversation = async (
  deps: ConversationDeps,
  model: string,
): Promise<Conversation> => {
  const now = deps.clock.now();

  const conversation: Conversation = {
    id: deps.newId(),
    title: 'Nova conversa',
    model,
    createdAt: now,
    updatedAt: now,
  };

  await deps.store.putConversation(conversation);
  return conversation;
};

export const renameConversation = async (
  deps: ConversationDeps,
  id: ConversationId,
  title: string,
): Promise<Conversation | null> => {
  const conversation = await deps.store.getConversation(id);
  if (!conversation) return null;

  const clean = normalizeTitle(title);
  if (!clean) return conversation;

  const updated: Conversation = {
    ...conversation,
    title: clean.slice(0, MAX_TITLE_LENGTH),
    updatedAt: deps.clock.now(),
  };

  await deps.store.putConversation(updated);
  return updated;
};

/** O seletor muda a Conversa atual; o `updatedAt` não muda porque nada foi dito. */
export const changeModel = async (
  deps: ConversationDeps,
  id: ConversationId,
  model: string,
): Promise<Conversation | null> => {
  const conversation = await deps.store.getConversation(id);
  if (!conversation) return null;

  const updated: Conversation = { ...conversation, model };
  await deps.store.putConversation(updated);
  return updated;
};

export const deleteConversation = async (
  deps: ConversationDeps,
  id: ConversationId,
): Promise<void> => {
  await deps.store.deleteConversation(id);
};
