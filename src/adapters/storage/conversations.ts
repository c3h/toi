import Dexie from 'dexie';
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
}
