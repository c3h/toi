import Dexie, { liveQuery } from 'dexie';
import type { Conversation } from '../../domain/conversation';
import type { ConversationId, MessageId } from '../../domain/ids';
import type { Message } from '../../domain/message';
import type { ConversationStore } from '../../ports/conversation-store';
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

  async deleteConversation(id: ConversationId): Promise<void> {
    await this.#db.transaction('rw', this.#db.conversations, this.#db.messages, async () => {
      await this.#db.conversations.delete(id);
      await this.#db.messages.where('conversationId').equals(id).delete();
    });
  }

  async listMessages(conversationId: ConversationId): Promise<Message[]> {
    const records = await this.#db.messages
      .where('[conversationId+seq]')
      .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
      .toArray();
    return records.map(fromMessageRecord);
  }

  async getMessage(id: MessageId): Promise<Message | null> {
    const record = await this.#db.messages.get(id);
    return record ? fromMessageRecord(record) : null;
  }

  async putMessage(message: Message): Promise<void> {
    await this.#db.messages.put(toMessageRecord(message));
  }

  async listStreamingMessages(): Promise<Message[]> {
    const records = await this.#db.messages.where('status').equals('streaming').toArray();
    return records.map(fromMessageRecord);
  }

  async clearConversations(): Promise<void> {
    await this.#db.transaction('rw', this.#db.conversations, this.#db.messages, async () => {
      await this.#db.conversations.clear();
      await this.#db.messages.clear();
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

/** `liveQuery` reexecuta a leitura quando a tabela muda, também em outra aba. */
const watch = <T>(query: () => Promise<T>, listener: (value: T) => void): (() => void) => {
  const subscription = liveQuery(query).subscribe({
    next: listener,
    // Leitura que falha não tem para onde ir: a próxima mudança tenta de novo.
    error: () => undefined,
  });
  return () => subscription.unsubscribe();
};
