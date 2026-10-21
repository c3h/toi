import type { Model } from '../../domain/model';
import type { Clock } from '../../ports/clock';
import { unreadableError } from './error';
import { anthropicFetch, type FetchLike } from './fetch';
import type { AnthropicModelsPage } from './types';

const MODELS_URL = 'https://api.anthropic.com/v1/models';
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;

export async function fetchModels(
  apiKey: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  clock: Clock,
): Promise<Model[]> {
  const models: Model[] = [];
  let afterId: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(MODELS_URL);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (afterId) url.searchParams.set('after_id', afterId);

    const response = await anthropicFetch(fetchImpl, apiKey, url, { signal }, clock);

    let body: AnthropicModelsPage;
    try {
      body = (await response.json()) as AnthropicModelsPage;
    } catch (cause) {
      throw unreadableError(cause);
    }

    for (const model of body.data ?? []) {
      if (model.lifecycle && model.lifecycle !== 'active') continue;

      models.push({
        id: model.id,
        displayName: model.display_name ?? model.id,
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
