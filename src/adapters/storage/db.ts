import Dexie, { type Table } from 'dexie';
import type { Conversation } from '../../domain/conversation';
import type { Message } from '../../domain/message';

interface SettingRow {
  key: string;
  value: unknown;
}

interface CredentialRow {
  provider: string;
  apiKey: string;
}

export class ToiDatabase extends Dexie {
  conversations!: Table<Conversation, string>;
  messages!: Table<Message, string>;
  settings!: Table<SettingRow, string>;
  credentials!: Table<CredentialRow, string>;

  constructor(name = 'toi') {
    super(name);

    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: 'id, conversationId, [conversationId+seq], status',
      settings: 'key',
      credentials: 'provider',
    });
  }
}
