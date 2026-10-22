import Dexie, { type Table } from 'dexie';
import type { AttachmentBytesRecord, ConversationRecord, MessageRecord } from './records';

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
  attachments!: Table<AttachmentBytesRecord, string>;
  settings!: Table<SettingRow, string>;
  credentials!: Table<CredentialRow, string>;

  constructor(name = 'toi') {
    super(name);

    // Pré-produção: mudar a forma em `records.ts` edita esta versão, sem `upgrade()` (AGENTS.md).
    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: 'id, conversationId, [conversationId+seq], status',
      attachments: 'id, conversationId',
      settings: 'key',
      credentials: 'provider',
    });
  }
}
