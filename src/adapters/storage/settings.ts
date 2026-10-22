import type { ProviderId } from '../../domain/ids';
import type { Model, ModelPicks, ModelRef } from '../../domain/model';
import type { SettingsStore } from '../../ports/settings-store';
import type { ToiDatabase } from './db';
import {
  fromModelPicksRecord,
  fromModelRecord,
  fromModelRefRecord,
  isModelPicksRecord,
  isModelRefRecord,
  toModelPicksRecord,
  toModelRecord,
  toModelRefRecord,
  type ModelRecord,
} from './records';

const modelsKey = (provider: ProviderId): string => `models:${provider}`;
const LAST_MODEL_KEY = 'lastModel';
const MODEL_PICKS_KEY = 'modelPicks';

export class DexieSettingsStore implements SettingsStore {
  readonly #db: ToiDatabase;

  constructor(db: ToiDatabase) {
    this.#db = db;
  }

  async models(provider: ProviderId): Promise<Model[] | null> {
    const row = await this.#db.settings.get(modelsKey(provider));
    if (!Array.isArray(row?.value)) return null;
    return (row.value as ModelRecord[]).map(fromModelRecord);
  }

  async saveModels(provider: ProviderId, models: Model[]): Promise<void> {
    await this.#db.settings.put({ key: modelsKey(provider), value: models.map(toModelRecord) });
  }

  async lastModel(): Promise<ModelRef | null> {
    const row = await this.#db.settings.get(LAST_MODEL_KEY);
    return isModelRefRecord(row?.value) ? fromModelRefRecord(row.value) : null;
  }

  async saveLastModel(model: ModelRef): Promise<void> {
    await this.#db.settings.put({ key: LAST_MODEL_KEY, value: toModelRefRecord(model) });
  }

  async modelPicks(): Promise<ModelPicks | null> {
    const row = await this.#db.settings.get(MODEL_PICKS_KEY);
    return isModelPicksRecord(row?.value) ? fromModelPicksRecord(row.value) : null;
  }

  async saveModelPicks(picks: ModelPicks): Promise<void> {
    await this.#db.settings.put({ key: MODEL_PICKS_KEY, value: toModelPicksRecord(picks) });
  }

  async clear(): Promise<void> {
    await this.#db.settings.clear();
  }
}
