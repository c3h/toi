import Dexie from 'dexie';
import type { Conversation } from '../../domain/conversation';
import type { ConversationId, MessageId } from '../../domain/ids';
import type { Message } from '../../domain/message';
import type { ConversationStore } from '../../ports/conversation-store';
import type { ToiDatabase } from './db';

export class DexieConversationStore implements ConversationStore {
  readonly #db: ToiDatabase;

  constructor(db: ToiDatabase) {
    this.#db = db;
  }

  async listConversations(): Promise<Conversation[]> {
    return this.#db.conversations.orderBy('updatedAt').reverse().toArray();
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    return (await this.#db.conversations.get(id)) ?? null;
  }

  async putConversation(conversation: Conversation): Promise<void> {
    await this.#db.conversations.put(conversation);
  }

  async deleteConversation(id: ConversationId): Promise<void> {
    await this.#db.transaction('rw', this.#db.conversations, this.#db.messages, async () => {
      await this.#db.conversations.delete(id);
      await this.#db.messages.where('conversationId').equals(id).delete();
    });
  }

  async listMessages(conversationId: ConversationId): Promise<Message[]> {
    return this.#db.messages
      .where('[conversationId+seq]')
      .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
      .toArray();
  }

  async getMessage(id: MessageId): Promise<Message | null> {
    return (await this.#db.messages.get(id)) ?? null;
  }

  async putMessage(message: Message): Promise<void> {
    await this.#db.messages.put(message);
  }

  async listStreamingMessages(): Promise<Message[]> {
    return this.#db.messages.where('status').equals('streaming').toArray();
  }

  async clearConversations(): Promise<void> {
    await this.#db.transaction('rw', this.#db.conversations, this.#db.messages, async () => {
      await this.#db.conversations.clear();
      await this.#db.messages.clear();
    });
  }

  async clearAll(): Promise<void> {
    const { tables } = this.#db;
    await this.#db.transaction('rw', tables, () => Promise.all(tables.map((table) => table.clear())));
  }
}
