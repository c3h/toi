import type { ProviderId } from '../domain/ids';
import type { Model, ModelPicks, ModelRef } from '../domain/model';

/**
 * Configurações não são segredo. Guarda o cache de Modelos de cada Provedor,
 * o último Modelo escolhido, que só define o default de uma Conversa nova, e
 * quais Modelos o seletor oferece.
 */
export interface SettingsStore {
  models(provider: ProviderId): Promise<Model[] | null>;
  saveModels(provider: ProviderId, models: Model[]): Promise<void>;
  lastModel(): Promise<ModelRef | null>;
  saveLastModel(model: ModelRef): Promise<void>;
  /** `null` enquanto a pessoa não mexeu na lista. */
  modelPicks(): Promise<ModelPicks | null>;
  saveModelPicks(picks: ModelPicks): Promise<void>;
  clear(): Promise<void>;
}
