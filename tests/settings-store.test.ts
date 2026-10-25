import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DexieSettingsStore } from '../src/adapters/storage/settings';
import { withDb } from './dexie';

describe('DexieSettingsStore: Instruções', () => {
  it('grava, lê e, com null, apaga a linha', () =>
    withDb(async (db) => {
      const settings = new DexieSettingsStore(db);
      expect(await settings.instructions()).toBeNull();

      await settings.saveInstructions('responda curto');
      expect(await settings.instructions()).toBe('responda curto');

      await settings.saveInstructions(null);
      expect(await settings.instructions()).toBeNull();
      expect(await db.settings.get('instructions')).toBeUndefined();
    }));
});
