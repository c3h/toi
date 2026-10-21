import type { Model } from '../domain/model';

/**
 * Configurações não são segredo. Guarda o cache de Modelos da Chave atual e
 * o último Modelo escolhido, que só define o default de uma Conversa nova.
 */
export interface SettingsStore {
  models(): Promise<Model[] | null>;
  saveModels(models: Model[]): Promise<void>;
  lastModel(): Promise<string | null>;
  saveLastModel(id: string): Promise<void>;
  clear(): Promise<void>;
}
