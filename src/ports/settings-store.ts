import type { ProviderId } from '../domain/ids';
import type { Effort, Model, ModelPicks, ModelRef } from '../domain/model';
import type { ToolSpace } from '../domain/web';

/**
 * Configurações não são segredo. Guarda o cache de Modelos de cada Provedor,
 * o último Modelo e o último Esforço escolhidos, que só definem o default de
 * uma Conversa nova, quais Modelos o seletor oferece, o espaço das Ferramentas
 * e o Modelo que nomeia as Conversas.
 */
export interface SettingsStore {
  models(provider: ProviderId): Promise<Model[] | null>;
  saveModels(provider: ProviderId, models: Model[]): Promise<void>;
  lastModel(): Promise<ModelRef | null>;
  saveLastModel(model: ModelRef): Promise<void>;
  /** `null` enquanto a pessoa não escolheu um Esforço. */
  lastEffort(): Promise<Effort | null>;
  saveLastEffort(effort: Effort): Promise<void>;
  /** `null` enquanto a pessoa não mexeu na lista. */
  modelPicks(): Promise<ModelPicks | null>;
  saveModelPicks(picks: ModelPicks): Promise<void>;
  /** `null` enquanto a pessoa não escolheu um espaço. */
  toolSpace(): Promise<ToolSpace | null>;
  saveToolSpace(space: ToolSpace): Promise<void>;
  /** `null` enquanto a pessoa não escolheu um Modelo para o Título. */
  titleModel(): Promise<ModelRef | null>;
  saveTitleModel(model: ModelRef): Promise<void>;
  clear(): Promise<void>;
}
