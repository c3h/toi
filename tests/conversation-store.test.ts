import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { DexieConversationStore } from '../src/adapters/storage/conversations';
import { ToiDatabase } from '../src/adapters/storage/db';
import { DexieSettingsStore } from '../src/adapters/storage/settings';
import { describeConversationStore } from './conversation-store.contract';
import { MemoryStore, testModel } from './helpers';

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

  it('DexieSettingsStore guarda o cache de Modelos e o último Modelo', () =>
    withDb(async (db) => {
      const settings = new DexieSettingsStore(db);
      expect(await settings.models('anthropic')).toBeNull();
      expect(await settings.lastModel()).toBeNull();

      await settings.saveModels('anthropic', [testModel]);
      await settings.saveLastModel({ provider: 'anthropic', id: testModel.id });

      expect(await settings.models('anthropic')).toEqual([testModel]);
      expect(await settings.lastModel()).toEqual({ provider: 'anthropic', id: testModel.id });
    }));

  it('DexieSettingsStore guarda o que o seletor oferece e ignora valor ilegível', () =>
    withDb(async (db) => {
      const settings = new DexieSettingsStore(db);
      expect(await settings.modelPicks()).toBeNull();

      const picks = {
        families: [{ provider: 'anthropic' as const, name: 'sonnet' }],
        models: [{ provider: 'anthropic' as const, id: 'claude-opus-5-5' }],
      };
      await settings.saveModelPicks(picks);
      expect(await settings.modelPicks()).toEqual(picks);

      await db.settings.put({ key: 'modelPicks', value: { families: ['sonnet'], models: [] } });
      expect(await settings.modelPicks()).toBeNull();
    }));

  it('a v2 do banco atribui à Anthropic o que a v1 gravou', async () => {
    const name = `toi-test-${(dbCount += 1)}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      conversations: 'id, updatedAt',
      messages: 'id, conversationId, [conversationId+seq], status',
      settings: 'key',
      credentials: 'provider',
    });
    await v1.table('conversations').put({
      id: 'c1',
      title: 'Antiga',
      model: 'claude-sonnet-5',
      createdAt: 1,
      updatedAt: 2,
    });
    const message = {
      conversationId: 'c1',
      parts: [{ type: 'text', text: 'oi' }],
      status: 'complete',
      createdAt: 1,
      completedAt: 1,
      usage: null,
      stopReason: null,
      error: null,
      stream: null,
    };
    await v1.table('messages').bulkPut([
      { ...message, id: 'm1', seq: 1, role: 'user', model: null },
      { ...message, id: 'm2', seq: 2, role: 'assistant', model: 'claude-sonnet-5' },
    ]);
    await v1.table('settings').bulkPut([
      { key: 'models', value: [{ id: 'claude-sonnet-5' }] },
      { key: 'lastModel', value: 'claude-sonnet-5' },
      { key: 'theme', value: 'dark' },
    ]);
    v1.close();

    const db = new ToiDatabase(name);
    try {
      const store = new DexieConversationStore(db);
      const settings = new DexieSettingsStore(db);

      expect(await store.getConversation('c1')).toMatchObject({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        title: 'Antiga',
      });
      expect(
        (await store.listMessages('c1')).map((item) => [item.role, item.provider, item.model]),
      ).toEqual([
        ['user', null, null],
        ['assistant', 'anthropic', 'claude-sonnet-5'],
      ]);
      expect(await settings.models('anthropic')).toBeNull();
      expect(await db.settings.get('models')).toBeUndefined();
      expect(await settings.lastModel()).toEqual({ provider: 'anthropic', id: 'claude-sonnet-5' });
      expect(await db.settings.get('theme')).toEqual({ key: 'theme', value: 'dark' });
    } finally {
      await dropDb(db);
    }
  });
});
