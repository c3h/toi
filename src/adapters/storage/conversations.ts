import Dexie, { liveQuery } from 'dexie';
import type { Conversation } from '../../domain/conversation';
import { appError, missingAttachmentError } from '../../domain/error';
import type { AttachmentId, ConversationId, MessageId } from '../../domain/ids';
import type { Message } from '../../domain/message';
import type {
  ConversationStore,
  HistorySnapshot,
  TurnWrite,
} from '../../ports/conversation-store';
import type { ToiDatabase } from './db';
import {
  fromConversationRecord,
  fromMessageRecord,
  toConversationRecord,
  toMessageRecord,
} from './records';

export class DexieConversationStore implements ConversationStore {
  readonly #db: ToiDatabase;

  constructor(db: ToiDatabase) {
    this.#db = db;
  }

  /** As Mensagens de uma Conversa em ordem de `seq`: o mesmo índice filtra e ordena. */
  #messagesOf(conversationId: ConversationId) {
    return this.#db.messages
      .where('[conversationId+seq]')
      .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey]);
  }

  async listConversations(): Promise<Conversation[]> {
    const records = await this.#db.conversations.orderBy('updatedAt').reverse().toArray();
    return records.map(fromConversationRecord);
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    const record = await this.#db.conversations.get(id);
    return record ? fromConversationRecord(record) : null;
  }

  async putConversation(conversation: Conversation): Promise<void> {
    await this.#db.conversations.put(toConversationRecord(conversation));
  }

  updateConversation(
    id: ConversationId,
    change: (conversation: Conversation) => Conversation,
  ): Promise<Conversation | null> {
    // Transações `rw` no mesmo store são serializadas pelo IndexedDB, também entre abas.
    return this.#db.transaction('rw', this.#db.conversations, async () => {
      const record = await this.#db.conversations.get(id);
      if (!record) return null;

      const updated = change(fromConversationRecord(record));
      await this.#db.conversations.put(toConversationRecord(updated));
      return updated;
    });
  }

  async startTurn(turn: TurnWrite): Promise<Conversation | null> {
    const { conversations, messages, attachments } = this.#db;

    try {
      return await this.#db.transaction('rw', [conversations, messages, attachments], async () => {
        const record = await conversations.get(turn.conversationId);
        if (!record) return null;

        const updated = turn.change(fromConversationRecord(record));
        await conversations.put(toConversationRecord(updated));
        await messages.bulkPut(turn.messages.map(toMessageRecord));
        await attachments.bulkPut(
          turn.attachments.map(({ attachment, blob }) => ({
            id: attachment.id,
            conversationId: turn.conversationId,
            blob,
          })),
        );
        return updated;
      });
    } catch (cause) {
      throw appError(isQuotaError(cause) ? 'storage_full' : 'storage_failed', { cause });
    }
  }

  async deleteConversation(id: ConversationId): Promise<void> {
    const { conversations, messages, attachments } = this.#db;
    await this.#db.transaction('rw', [conversations, messages, attachments], async () => {
      await conversations.delete(id);
      await this.#messagesOf(id).delete();
      await attachments.where('conversationId').equals(id).delete();
    });
  }

  async listMessages(conversationId: ConversationId): Promise<Message[]> {
    const records = await this.#messagesOf(conversationId).toArray();
    return records.map(fromMessageRecord);
  }

  async getMessage(id: MessageId): Promise<Message | null> {
    const record = await this.#db.messages.get(id);
    return record ? fromMessageRecord(record) : null;
  }

  async putMessage(message: Message): Promise<void> {
    await this.#db.messages.put(toMessageRecord(message));
  }

  async readAttachments(ids: AttachmentId[]): Promise<Blob[]> {
    const records = await this.#db.attachments.bulkGet(ids);
    return records.map((record) => {
      if (!record) throw missingAttachmentError();
      return record.blob;
    });
  }

  async listStreamingMessages(): Promise<Message[]> {
    const records = await this.#db.messages.where('status').equals('streaming').toArray();
    return records.map(fromMessageRecord);
  }

  async clearConversations(): Promise<void> {
    const { conversations, messages, attachments } = this.#db;
    await this.#db.transaction('rw', [conversations, messages, attachments], async () => {
      await conversations.clear();
      await messages.clear();
      await attachments.clear();
    });
  }

  snapshot(): Promise<HistorySnapshot> {
    const { conversations, messages, attachments } = this.#db;
    return this.#db.transaction('r', [conversations, messages, attachments], async () => {
      const [conversationRecords, messageRecords, attachmentRecords] = await Promise.all([
        conversations.orderBy('updatedAt').reverse().toArray(),
        messages.orderBy('[conversationId+seq]').toArray(),
        attachments.toArray(),
      ]);

      const byConversation = new Map<ConversationId, Message[]>();
      for (const record of messageRecords) {
        const list = byConversation.get(record.conversationId) ?? [];
        list.push(fromMessageRecord(record));
        byConversation.set(record.conversationId, list);
      }

      return {
        conversations: conversationRecords.map((record) => ({
          conversation: fromConversationRecord(record),
          messages: byConversation.get(record.id) ?? [],
        })),
        attachments: new Map(attachmentRecords.map((record) => [record.id, record.blob])),
      };
    });
  }

  watchConversations(listener: (conversations: Conversation[]) => void): () => void {
    return watch(() => this.listConversations(), listener);
  }

  watchMessages(
    conversationId: ConversationId,
    listener: (messages: Message[]) => void,
  ): () => void {
    return watch(() => this.listMessages(conversationId), listener);
  }
}

/** O Dexie embrulha o erro do IndexedDB quando a transação aborta; a causa fica em `inner`. */
const isQuotaError = (error: unknown): boolean => {
  let current = error;
  while (current instanceof Error) {
    if (current.name === 'QuotaExceededError') return true;
    current = (current as { inner?: unknown }).inner;
  }
  return false;
};

/** `liveQuery` reexecuta a leitura quando a tabela muda, também em outra aba. */
const watch = <T>(query: () => Promise<T>, listener: (value: T) => void): (() => void) => {
  const subscription = liveQuery(query).subscribe({
    next: listener,
    // Leitura que falha não tem para onde ir: a próxima mudança tenta de novo.
    error: () => undefined,
  });
  return () => subscription.unsubscribe();
};
