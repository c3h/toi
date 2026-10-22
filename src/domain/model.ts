import type { ProviderId } from './ids';

/** Níveis de Esforço, do menor ao maior. Todo Modelo oferecido aceita todos. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORTS)[number];

/** O Esforço da primeira Conversa: o menor. Depois, vale o do último envio. */
export const DEFAULT_EFFORT: Effort = EFFORTS[0];

export interface Model {
  provider: ProviderId;
  id: string;
  displayName: string;
  /** Preenchida pelo Provedor: cada um nomeia suas famílias. */
  family: string;
  maxTokens: number | null;
  maxInputTokens: number | null;
  createdAt: string;
  /** Aceita responder sem raciocinar; o que não aceita raciocina no Esforço pedido. */
  reasoningOff: boolean;
}

/** Identidade de um Modelo. O id sozinho colide entre Provedores. */
export interface ModelRef {
  provider: ProviderId;
  id: string;
}

export const refOf = (model: Model): ModelRef => ({ provider: model.provider, id: model.id });

/** O Modelo que uma Conversa ou Mensagem guarda em dois campos; `null` se não guarda. */
export const refFrom = (
  item: { provider: ProviderId | null; model: string | null } | null,
): ModelRef | null => (item?.provider && item.model ? { provider: item.provider, id: item.model } : null);

/** O inverso de `refFrom`: os dois campos que a Conversa ou Mensagem grava. */
export const fieldsOf = (ref: ModelRef): { provider: ProviderId; model: string } => ({
  provider: ref.provider,
  model: ref.id,
});

export const isModel = (model: Model, ref: ModelRef | null): boolean =>
  ref !== null && model.provider === ref.provider && model.id === ref.id;

export const findModel = (models: Model[], ref: ModelRef | null): Model | null =>
  models.find((model) => isModel(model, ref)) ?? null;

/** O último Modelo escolhido, se ainda existe; senão o mais recente. */
export const defaultModel = (models: Model[], last: ModelRef | null): Model | null =>
  findModel(models, last) ??
  models.reduce<Model | null>(
    (newest, model) => (newest === null || model.createdAt > newest.createdAt ? model : newest),
    null,
  );

export interface FamilyRef {
  provider: ProviderId;
  name: string;
}

/**
 * Quais Modelos o seletor oferece. Uma família marcada acompanha a versão
 * mais recente dela; um Modelo marcado fixa aquela versão.
 */
export interface ModelPicks {
  families: FamilyRef[];
  models: ModelRef[];
}

export interface ModelFamily {
  provider: ProviderId;
  name: string;
  /** Da mais recente para a mais antiga. */
  models: Model[];
}

/** Famílias ordenadas pela versão mais recente de cada uma; a mesma família em dois Provedores são duas. */
export const modelFamilies = (models: Model[]): ModelFamily[] => {
  const groups = new Map<string, ModelFamily>();
  const newestFirst = [...models].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const model of newestFirst) {
    const key = `${model.provider}\u0000${model.family}`;
    const group = groups.get(key);
    if (group) group.models.push(model);
    else groups.set(key, { provider: model.provider, name: model.family, models: [model] });
  }
  return [...groups.values()];
};

const isFamily = (family: ModelFamily, ref: FamilyRef): boolean =>
  family.provider === ref.provider && family.name === ref.name;

const isPicked = (family: ModelFamily, model: Model, picks: ModelPicks): boolean =>
  picks.models.some((ref) => isModel(model, ref)) ||
  (model === family.models[0] && picks.families.some((ref) => isFamily(family, ref)));

/** Os Modelos do seletor; vazio quando nenhuma marcação existe para a Chave. */
export const pickedModels = (models: Model[], picks: ModelPicks): Model[] =>
  modelFamilies(models).flatMap((family) =>
    family.models.filter((model) => isPicked(family, model, picks)),
  );

/** Marcar a versão mais recente marca a família; qualquer outra, só ela. */
export const togglePick = (family: ModelFamily, picks: ModelPicks, model: Model): ModelPicks => {
  const newest = model === family.models[0];

  if (isPicked(family, model, picks)) {
    return {
      families: newest ? picks.families.filter((ref) => !isFamily(family, ref)) : picks.families,
      models: picks.models.filter((ref) => !isModel(model, ref)),
    };
  }
  return newest
    ? { families: [...picks.families, { provider: family.provider, name: family.name }], models: picks.models }
    : { families: picks.families, models: [...picks.models, refOf(model)] };
};

/**
 * O Modelo que nomeia as Conversas, entre os do seletor: o escolhido ou, sem
 * escolha, a versão mais recente da família que o Provedor sugere. `null`
 * quando ele não está no seletor; nunca troca por outro em silêncio.
 */
export const titleModelOf = (
  picked: Model[],
  saved: ModelRef | null,
  suggested: FamilyRef[],
): Model | null =>
  saved !== null
    ? findModel(picked, saved)
    : (modelFamilies(picked).find((family) => suggested.some((ref) => isFamily(family, ref)))
        ?.models[0] ?? null);
