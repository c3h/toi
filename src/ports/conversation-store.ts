import type { Conversation } from '../domain/conversation';
import type { ConversationId, MessageId } from '../domain/ids';
import type { Message } from '../domain/message';

/**
 * Histórico Local. `listConversations` ordena por `updatedAt` decrescente;
 * `listMessages` ordena por `seq`; os `put*` são upsert. `updateConversation`
 * lê e grava numa só transação, para uma aba não desfazer o que outra mudou
 * entre a leitura e a escrita; não recria uma Conversa apagada. `deleteConversation`
 * remove as Mensagens junto. A porta não alcança `credentials`: "apagar tudo"
 * é composição no app.
 *
 * `watch*` entrega o estado atual e de novo a cada mudança gravada, inclusive
 * por outra aba; devolve o cancelamento. Durante um Fluxo, o store só vê o
 * que já passou pelo flush.
 */
export interface ConversationStore {
  listConversations(): Promise<Conversation[]>;
  getConversation(id: ConversationId): Promise<Conversation | null>;
  putConversation(conversation: Conversation): Promise<void>;
  /** `null` se a Conversa não existe. */
  updateConversation(
    id: ConversationId,
    change: (conversation: Conversation) => Conversation,
  ): Promise<Conversation | null>;
  deleteConversation(id: ConversationId): Promise<void>;
  listMessages(conversationId: ConversationId): Promise<Message[]>;
  getMessage(id: MessageId): Promise<Message | null>;
  putMessage(message: Message): Promise<void>;
  listStreamingMessages(): Promise<Message[]>;
  clearConversations(): Promise<void>;
  watchConversations(listener: (conversations: Conversation[]) => void): () => void;
  watchMessages(conversationId: ConversationId, listener: (messages: Message[]) => void): () => void;
}
