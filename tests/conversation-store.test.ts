import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DexieConversationStore } from '../src/adapters/storage/conversations';
import { ToiDatabase } from '../src/adapters/storage/db';
import { DexieSettingsStore } from '../src/adapters/storage/settings';
import { describeConversationStore } from './conversation-store.contract';
import { MemoryStore } from './helpers';

let dbCount = 0;

const openDb = (): ToiDatabase => new ToiDatabase(`toi-test-${(dbCount += 1)}`);

const dropDb = async (db: ToiDatabase): Promise<void> => {
  db.close();
  await db.delete();
};

const withDb = async (task: (db: ToiDatabase) => Promise<void>): Promise<void> => {
  const db = openDb();
  try {
    await task(db);
  } finally {
    await dropDb(db);
  }
};

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

  it('DexieSettingsStore.clear limpa settings e preserva credentials', () =>
    withDb(async (db) => {
      await db.credentials.put({ provider: 'anthropic', apiKey: 'sk-test' });
      await db.settings.put({ key: 'theme', value: 'dark' });

      await new DexieSettingsStore(db).clear();

      expect(await db.settings.get('theme')).toBeUndefined();
      expect(await db.credentials.get('anthropic')).toEqual({
        provider: 'anthropic',
        apiKey: 'sk-test',
      });
    }));
});
