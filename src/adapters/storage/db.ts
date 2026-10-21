import Dexie, { type Table } from 'dexie';
import type { ConversationRecord, MessageRecord } from './records';

interface SettingRow {
  key: string;
  value: unknown;
}

interface CredentialRow {
  provider: string;
  apiKey: string;
}

export class ToiDatabase extends Dexie {
  conversations!: Table<ConversationRecord, string>;
  messages!: Table<MessageRecord, string>;
  settings!: Table<SettingRow, string>;
  credentials!: Table<CredentialRow, string>;

  constructor(name = 'toi') {
    super(name);

    // Mudou a forma em `records.ts`? Nova `version(n)` com `upgrade()`; nunca editar a anterior.
    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: 'id, conversationId, [conversationId+seq], status',
      settings: 'key',
      credentials: 'provider',
    });
  }
}
