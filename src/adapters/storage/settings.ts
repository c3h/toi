import type { ProviderId } from '../../domain/ids';
import type { Model, ModelPicks, ModelRef } from '../../domain/model';
import type { SettingsStore } from '../../ports/settings-store';
import type { ToiDatabase } from './db';
import {
  fromModelPicksRecord,
  fromModelRecord,
  fromModelRefRecord,
  toModelPicksRecord,
  toModelRecord,
  toModelRefRecord,
  type ModelPicksRecord,
  type ModelRecord,
  type ModelRefRecord,
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
    return row ? (row.value as ModelRecord[]).map(fromModelRecord) : null;
  }

  async saveModels(provider: ProviderId, models: Model[]): Promise<void> {
    await this.#db.settings.put({ key: modelsKey(provider), value: models.map(toModelRecord) });
  }

  async lastModel(): Promise<ModelRef | null> {
    const row = await this.#db.settings.get(LAST_MODEL_KEY);
    return row ? fromModelRefRecord(row.value as ModelRefRecord) : null;
  }

  async saveLastModel(model: ModelRef): Promise<void> {
    await this.#db.settings.put({ key: LAST_MODEL_KEY, value: toModelRefRecord(model) });
  }

  async modelPicks(): Promise<ModelPicks | null> {
    const row = await this.#db.settings.get(MODEL_PICKS_KEY);
    return row ? fromModelPicksRecord(row.value as ModelPicksRecord) : null;
  }

  async saveModelPicks(picks: ModelPicks): Promise<void> {
    await this.#db.settings.put({ key: MODEL_PICKS_KEY, value: toModelPicksRecord(picks) });
  }

  async clear(): Promise<void> {
    await this.#db.settings.clear();
  }
}
