import type { Model } from '../../domain/model';
import type { SettingsStore } from '../../ports/settings-store';
import type { ToiDatabase } from './db';
import { fromModelRecord, toModelRecord, type ModelRecord } from './records';

const MODELS_KEY = 'models';
const LAST_MODEL_KEY = 'lastModel';

export class DexieSettingsStore implements SettingsStore {
  readonly #db: ToiDatabase;

  constructor(db: ToiDatabase) {
    this.#db = db;
  }

  async models(): Promise<Model[] | null> {
    const row = await this.#db.settings.get(MODELS_KEY);
    if (!Array.isArray(row?.value)) return null;
    return (row.value as ModelRecord[]).map(fromModelRecord);
  }

  async saveModels(models: Model[]): Promise<void> {
    await this.#db.settings.put({ key: MODELS_KEY, value: models.map(toModelRecord) });
  }

  async lastModel(): Promise<string | null> {
    const row = await this.#db.settings.get(LAST_MODEL_KEY);
    return typeof row?.value === 'string' ? row.value : null;
  }

  async saveLastModel(id: string): Promise<void> {
    await this.#db.settings.put({ key: LAST_MODEL_KEY, value: id });
  }

  async clear(): Promise<void> {
    await this.#db.settings.clear();
  }
}
