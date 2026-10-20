import type { ConversationStore } from '../ports/conversation-store';

export const eraseConversations = (store: ConversationStore): Promise<void> =>
  store.clearConversations();

export const eraseAll = (store: ConversationStore): Promise<void> => store.clearAll();
