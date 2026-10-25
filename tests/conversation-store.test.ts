import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DexieConversationStore } from '../src/adapters/storage/conversations';
import { describeConversationStore } from './conversation-store.contract';
import { dropDb, openDb, withDb } from './dexie';
import { makeConversation, makeMessage, MemoryStore, textFile } from './helpers';

describeConversationStore('MemoryStore', async () => {
  const store = new MemoryStore();

  return {
    store,
    cleanup: async () => undefined,
  };
});

describeConversationStore('DexieConversationStore', async () => {
  const db = openDb();
  const store = new DexieConversationStore(db);

  return { store, cleanup: () => dropDb(db) };
});

describe('DexieConversationStore: fronteira da Chave', () => {
  it('clearConversations não toca em credentials nem settings', () =>
    withDb(async (db) => {
      await db.credentials.put({ provider: 'anthropic', apiKey: 'sk-test' });
      await db.settings.put({ key: 'theme', value: 'dark' });

      await new DexieConversationStore(db).clearConversations();

      expect(await db.credentials.get('anthropic')).toEqual({
        provider: 'anthropic',
        apiKey: 'sk-test',
      });
      expect(await db.settings.get('theme')).toEqual({ key: 'theme', value: 'dark' });
    }));
});

describe('DexieConversationStore: startTurn sem espaço', () => {
  it('recusa com storage_full e não grava nada', () =>
    withDb(async (db) => {
      const store = new DexieConversationStore(db);
      await store.putConversation(makeConversation('c1', { title: 'Antes' }));
      // O IndexedDB recusa a última escrita da transação, como faz com a cota cheia.
      Object.assign(db.attachments, {
        bulkPut: () => Promise.reject(new DOMException('cota', 'QuotaExceededError')),
      });

      await expect(
        store.startTurn({
          conversationId: 'c1',
          change: (current) => ({ ...current, title: 'Depois' }),
          messages: [makeMessage({ id: 'm1', conversationId: 'c1', seq: 1, role: 'user' })],
          attachments: [textFile('a1')],
        }),
      ).rejects.toMatchObject({ code: 'storage_full' });

      expect(await store.getConversation('c1')).toMatchObject({ title: 'Antes' });
      expect(await store.listMessages('c1')).toEqual([]);
    }));
});

describe('DexieConversationStore: o IndexedDB clona o registro', () => {
  it('o input de tool_call gravado e o lido não compartilham objeto', () =>
    withDb(async (db) => {
      const store = new DexieConversationStore(db);
      const input = { query: 'antes', nested: { n: 1 } };
      await store.putMessage(
        makeMessage({
          id: 'm1',
          conversationId: 'c1',
          seq: 1,
          role: 'assistant',
          parts: [{ type: 'tool_call', callId: 't1', tool: 'web_search', input }],
        }),
      );

      // O IndexedDB clona ao gravar e a cada leitura: mexer num lado não muda o outro.
      input.nested.n = 2;
      const read = await store.getMessage('m1');
      const part = read!.parts[0]!;
      if (part.type !== 'tool_call') throw new Error('esperava tool_call');
      expect(part.input).toEqual({ query: 'antes', nested: { n: 1 } });

      part.input.query = 'depois';
      expect((await store.listMessages('c1'))[0]!.parts[0]).toMatchObject({
        input: { query: 'antes', nested: { n: 1 } },
      });
    }));
});
