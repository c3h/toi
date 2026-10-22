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

    // v2: Conversa e Mensagem ganham `provider`; tudo que já existe veio da Anthropic.
    // As chaves de `settings` abaixo são as da v1, congeladas aqui.
    // Índices iguais aos da v1: o Dexie herda o schema e a v2 só traz o `upgrade()`.
    this.version(2)
      .stores({})
      .upgrade(async (tx) => {
        await tx
          .table('conversations')
          .toCollection()
          .modify((conversation: { provider?: string }) => {
            conversation.provider = 'anthropic';
          });
        await tx
          .table('messages')
          .toCollection()
          .modify((message: { role: string; provider?: string | null }) => {
            message.provider = message.role === 'assistant' ? 'anthropic' : null;
          });

        const settings = tx.table<SettingRow, string>('settings');
        // O cache não tinha Provedor nem família; some e a próxima abertura lista de novo.
        await settings.delete('models');
        const last = await settings.get('lastModel');
        if (typeof last?.value === 'string') {
          await settings.put({ key: 'lastModel', value: { provider: 'anthropic', id: last.value } });
        }
      });
  }
}
