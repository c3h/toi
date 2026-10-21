import type { Conversation } from '../domain/conversation';
import type { ConversationId, MessageId } from '../domain/ids';
import type { Message } from '../domain/message';

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
  clearAll(): Promise<void>;
}
