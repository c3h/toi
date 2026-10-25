import { MAX_TITLE_LENGTH, normalizeTitle, type Conversation } from '../domain/conversation';
import type { ConversationId } from '../domain/ids';
import { fieldsOf, type Effort, type ModelRef } from '../domain/model';
import type { Clock } from '../ports/clock';
import type { ConversationStore } from '../ports/conversation-store';

export interface ConversationDeps {
  store: ConversationStore;
  clock: Clock;
  newId: () => string;
}

export const createConversation = async (
  deps: ConversationDeps,
  model: ModelRef,
  effort: Effort,
): Promise<Conversation> => {
  const now = deps.clock.now();

  const conversation: Conversation = {
    id: deps.newId(),
    title: 'Nova conversa',
    titleSource: 'derived',
    ...fieldsOf(model),
    effort,
    createdAt: now,
    updatedAt: now,
  };

  await deps.store.putConversation(conversation);
  return conversation;
};

export const renameConversation = (
  deps: ConversationDeps,
  id: ConversationId,
  title: string,
): Promise<Conversation | null> => {
  const clean = normalizeTitle(title);
  if (!clean) return deps.store.getConversation(id);

  return deps.store.updateConversation(id, (conversation) => ({
    ...conversation,
    title: clean.slice(0, MAX_TITLE_LENGTH),
    titleSource: 'manual',
    updatedAt: deps.clock.now(),
  }));
};

/** O seletor muda a Conversa atual; o `updatedAt` não muda porque nada foi dito. */
export const changeModel = (
  deps: ConversationDeps,
  id: ConversationId,
  model: ModelRef,
): Promise<Conversation | null> =>
  deps.store.updateConversation(id, (conversation) => ({
    ...conversation,
    ...fieldsOf(model),
  }));

/** Como `changeModel`: muda a Conversa atual sem tocar em `updatedAt`. */
export const changeEffort = (
  deps: ConversationDeps,
  id: ConversationId,
  effort: Effort,
): Promise<Conversation | null> =>
  deps.store.updateConversation(id, (conversation) => ({ ...conversation, effort }));
