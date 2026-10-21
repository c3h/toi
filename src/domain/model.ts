export interface Model {
  id: string;
  displayName: string;
  maxTokens: number | null;
  maxInputTokens: number | null;
  createdAt: string;
}

/** O último Modelo escolhido, se ainda existe; senão o mais recente. */
export const defaultModel = (models: Model[], last: string | null): Model | null =>
  models.find((model) => model.id === last) ??
  models.reduce<Model | null>(
    (newest, model) => (newest === null || model.createdAt > newest.createdAt ? model : newest),
    null,
  );
