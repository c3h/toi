import type { Conversation } from '../domain/conversation';
import type { ConversationId, MessageId } from '../domain/ids';
import type { Message } from '../domain/message';

/**
 * Histórico Local. `listConversations` ordena por `updatedAt` decrescente;
 * `listMessages` ordena por `seq`; os `put*` são upsert. `deleteConversation`
 * remove as Mensagens junto. A porta não alcança `credentials`: "apagar tudo"
 * é composição no app.
 */
export interface ConversationStore {
  listConversations(): Promise<Conversation[]>;
  getConversation(id: ConversationId): Promise<Conversation | null>;
  putConversation(conversation: Conversation): Promise<void>;
  deleteConversation(id: ConversationId): Promise<void>;
  listMessages(conversationId: ConversationId): Promise<Message[]>;
  getMessage(id: MessageId): Promise<Message | null>;
  putMessage(message: Message): Promise<void>;
  listStreamingMessages(): Promise<Message[]>;
  clearConversations(): Promise<void>;
}
