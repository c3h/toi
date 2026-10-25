import { isAbortError } from '../../../domain/error';
import { isJsonObject } from '../../../domain/json';
import { EFFORTS, type Effort, type Model } from '../../../domain/model';
import type { Clock } from '../../../ports/clock';
import type { FetchLike } from '../../http/fetch';
import { anthropicFetch, API_URL } from './fetch';
import { anthropicErrors, anthropicInfo } from './info';
import { thinkingOff } from './thinking';

interface Supported {
  supported: boolean;
}

/** A API devolve a árvore inteira de capacidades, com `supported` em cada folha. */
type AnthropicEffortCapability = Supported & Record<Effort, Supported>;

interface AnthropicModel {
  id: string;
  display_name: string;
  /** Ausentes quando a API não informa o teto; o Modelo guarda `null` (§5, §7). */
  max_tokens?: number | null;
  max_input_tokens?: number | null;
  capabilities: { effort: AnthropicEffortCapability };
  created_at: string;
  lifecycle?: string;
}

/** Os campos que o Toi lê de uma página: o cursor só existe quando há outra. */
type AnthropicModelsPage = { data: AnthropicModel[] } & (
  | { has_more: true; last_id: string }
  | { has_more: false }
);

const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;

const isSupported = (value: unknown): value is Supported =>
  isJsonObject(value) && typeof value.supported === 'boolean';

const isEffortCapability = (value: unknown): value is AnthropicEffortCapability =>
  isJsonObject(value) && isSupported(value) && EFFORTS.every((level) => isSupported(value[level]));

const isLimit = (value: unknown): value is number | null | undefined =>
  value === undefined ||
  value === null ||
  (typeof value === 'number' && Number.isInteger(value) && value > 0);

const isAnthropicModel = (value: unknown): value is AnthropicModel =>
  isJsonObject(value) &&
  typeof value.id === 'string' &&
  typeof value.display_name === 'string' &&
  typeof value.created_at === 'string' &&
  isLimit(value.max_tokens) &&
  isLimit(value.max_input_tokens) &&
  (value.lifecycle === undefined || typeof value.lifecycle === 'string') &&
  isJsonObject(value.capabilities) &&
  isEffortCapability(value.capabilities.effort);

const isModelsPage = (value: unknown): value is AnthropicModelsPage =>
  isJsonObject(value) &&
  Array.isArray(value.data) &&
  value.data.every(isAnthropicModel) &&
  (value.has_more === false || (value.has_more === true && typeof value.last_id === 'string'));

/** O primeiro trecho só de letras do id depois de `claude`: `claude-3-5-sonnet-…` e `claude-sonnet-4-5` são `sonnet`. */
export const anthropicFamily = (id: string): string =>
  id.split('-').find((part) => part !== 'claude' && /^[a-z]+$/.test(part)) ?? id;

/** O Toi só oferece Modelos que aceitam a escala inteira de Esforço. */
const acceptsEveryEffort = (capability: AnthropicEffortCapability): boolean =>
  capability.supported && EFFORTS.every((level) => capability[level].supported);

/**
 * Lista os Modelos página a página. A forma de cada página é validada: uma
 * resposta fora do contrato vira erro, nunca nome, data ou lista inventados.
 */
export async function fetchModels(
  apiKey: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  clock: Clock,
): Promise<Model[]> {
  const models: Model[] = [];
  let afterId: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${API_URL}/models`);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (afterId) url.searchParams.set('after_id', afterId);

    const response = await anthropicFetch(fetchImpl, apiKey, url, { signal }, clock);

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      // Parar no meio do corpo passa intacto, como em `fetchOrThrow`.
      if (isAbortError(cause)) throw cause;
      throw anthropicErrors.unreadable(cause);
    }
    if (!isModelsPage(body)) throw anthropicErrors.unreadable(body);

    for (const model of body.data) {
      if (model.lifecycle !== undefined && model.lifecycle !== 'active') continue;
      if (!acceptsEveryEffort(model.capabilities.effort)) continue;

      models.push({
        provider: anthropicInfo.id,
        id: model.id,
        displayName: model.display_name,
        family: anthropicFamily(model.id),
        maxTokens: model.max_tokens ?? null,
        maxInputTokens: model.max_input_tokens ?? null,
        createdAt: model.created_at,
        reasoningOff: thinkingOff(model.id) !== null,
      });
    }

    if (!body.has_more || body.last_id === afterId) break;
    afterId = body.last_id;
  }

  return models;
}
