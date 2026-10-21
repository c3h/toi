import type { SettingsStore } from '../../ports/settings-store';
import type { ToiDatabase } from './db';

export class DexieSettingsStore implements SettingsStore {
  readonly #db: ToiDatabase;

  constructor(db: ToiDatabase) {
    this.#db = db;
  }

  async clear(): Promise<void> {
    await this.#db.settings.clear();
  }
}
