import type { Model } from '../../../domain/model';
import type { Clock } from '../../../ports/clock';
import type { FetchLike } from '../../http/fetch';
import { anthropicFetch, API_URL } from './fetch';
import { anthropicErrors, anthropicInfo } from './info';

interface AnthropicModel {
  id: string;
  display_name?: string;
  max_tokens?: number | null;
  max_input_tokens?: number | null;
  created_at?: string;
  lifecycle?: 'active' | 'deprecated' | 'retired';
}

interface AnthropicModelsPage {
  data: AnthropicModel[];
  has_more: boolean;
  last_id: string | null;
}

const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;

/** O primeiro trecho só de letras do id depois de `claude`: `claude-3-5-sonnet-…` e `claude-sonnet-4-5` são `sonnet`. */
export const anthropicFamily = (id: string): string =>
  id.split('-').find((part) => part !== 'claude' && /^[a-z]+$/.test(part)) ?? id;

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

    let body: AnthropicModelsPage;
    try {
      body = (await response.json()) as AnthropicModelsPage;
    } catch (cause) {
      throw anthropicErrors.unreadable(cause);
    }

    for (const model of body.data ?? []) {
      if (model.lifecycle && model.lifecycle !== 'active') continue;

      models.push({
        provider: anthropicInfo.id,
        id: model.id,
        displayName: model.display_name ?? model.id,
        family: anthropicFamily(model.id),
        maxTokens: model.max_tokens ?? null,
        maxInputTokens: model.max_input_tokens ?? null,
        createdAt: model.created_at ?? new Date(0).toISOString(),
      });
    }

    if (!body.has_more || !body.last_id || body.last_id === afterId) break;
    afterId = body.last_id;
  }

  return models;
}
