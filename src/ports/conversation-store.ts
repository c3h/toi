import type { AttachmentUpload } from '../domain/attachment';
import type { Conversation } from '../domain/conversation';
import type { AttachmentId, ConversationId, MessageId } from '../domain/ids';
import type { Message } from '../domain/message';

/**
 * O começo de um envio ou de uma tentativa: a mudança na Conversa, as
 * Mensagens novas e os Anexos da do user, gravados juntos ou nada.
 */
export interface TurnWrite {
  conversationId: ConversationId;
  /** Aplicada sobre a Conversa gravada, como em `updateConversation`. */
  change: (conversation: Conversation) => Conversation;
  messages: Message[];
  attachments: AttachmentUpload[];
}

/** Retrato do histórico lido numa só transação, para a Exportação. */
export interface HistorySnapshot {
  conversations: Array<{ conversation: Conversation; messages: Message[] }>;
  attachments: Map<AttachmentId, Blob>;
}

/**
 * Histórico Local. `listConversations` ordena por `updatedAt` decrescente;
 * `listMessages` ordena por `seq`; os `put*` são upsert. `updateConversation`
 * e `startTurn` leem e gravam numa só transação, para uma aba não desfazer o
 * que outra mudou entre a leitura e a escrita; não recriam uma Conversa
 * apagada. `startTurn` recusa com `storage_full` quando o navegador não tem
 * espaço e com `storage_failed` em qualquer outra falha, sem gravar nada.
 * `deleteConversation` remove as Mensagens e os Anexos junto. A porta não
 * alcança `credentials`: "apagar tudo" é composição no app.
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
  /** `null` se a Conversa não existe; nesse caso nada é gravado. */
  startTurn(turn: TurnWrite): Promise<Conversation | null>;
  deleteConversation(id: ConversationId): Promise<void>;
  listMessages(conversationId: ConversationId): Promise<Message[]>;
  getMessage(id: MessageId): Promise<Message | null>;
  putMessage(message: Message): Promise<void>;
  /** Os bytes na ordem dos ids; recusa com `storage_failed` se falta algum. */
  readAttachments(ids: AttachmentId[]): Promise<Blob[]>;
  listStreamingMessages(): Promise<Message[]>;
  clearConversations(): Promise<void>;
  snapshot(): Promise<HistorySnapshot>;
  watchConversations(listener: (conversations: Conversation[]) => void): () => void;
  watchMessages(conversationId: ConversationId, listener: (messages: Message[]) => void): () => void;
}
