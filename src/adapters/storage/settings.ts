import type { ProviderId } from '../../domain/ids';
import type { Effort, Model, ModelPicks, ModelRef } from '../../domain/model';
import type { ToolSpace } from '../../domain/web';
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
const LAST_EFFORT_KEY = 'lastEffort';
const MODEL_PICKS_KEY = 'modelPicks';
const TOOL_SPACE_KEY = 'toolSpace';
const TITLE_MODEL_KEY = 'titleModel';
const INSTRUCTIONS_KEY = 'instructions';

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

  async lastEffort(): Promise<Effort | null> {
    const row = await this.#db.settings.get(LAST_EFFORT_KEY);
    return row ? (row.value as Effort) : null;
  }

  async saveLastEffort(effort: Effort): Promise<void> {
    await this.#db.settings.put({ key: LAST_EFFORT_KEY, value: effort });
  }

  async modelPicks(): Promise<ModelPicks | null> {
    const row = await this.#db.settings.get(MODEL_PICKS_KEY);
    return row ? fromModelPicksRecord(row.value as ModelPicksRecord) : null;
  }

  async saveModelPicks(picks: ModelPicks): Promise<void> {
    await this.#db.settings.put({ key: MODEL_PICKS_KEY, value: toModelPicksRecord(picks) });
  }

  async toolSpace(): Promise<ToolSpace | null> {
    const row = await this.#db.settings.get(TOOL_SPACE_KEY);
    return row ? (row.value as ToolSpace) : null;
  }

  async saveToolSpace(space: ToolSpace): Promise<void> {
    await this.#db.settings.put({ key: TOOL_SPACE_KEY, value: space });
  }

  async titleModel(): Promise<ModelRef | null> {
    const row = await this.#db.settings.get(TITLE_MODEL_KEY);
    return row ? fromModelRefRecord(row.value as ModelRefRecord) : null;
  }

  async saveTitleModel(model: ModelRef): Promise<void> {
    await this.#db.settings.put({ key: TITLE_MODEL_KEY, value: toModelRefRecord(model) });
  }

  async instructions(): Promise<string | null> {
    const row = await this.#db.settings.get(INSTRUCTIONS_KEY);
    return row ? (row.value as string) : null;
  }

  async saveInstructions(text: string | null): Promise<void> {
    if (text === null) await this.#db.settings.delete(INSTRUCTIONS_KEY);
    else await this.#db.settings.put({ key: INSTRUCTIONS_KEY, value: text });
  }

  async clear(): Promise<void> {
    await this.#db.settings.clear();
  }
}
