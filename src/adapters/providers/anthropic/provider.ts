import type { Model } from '../../../domain/model';
import type { StreamEvent } from '../../../domain/stream';
import { systemClock, type Clock } from '../../../ports/clock';
import type { ChatProvider, ChatRequest, ProviderAdapter } from '../../../ports/chat-provider';
import type { FetchLike } from '../../http/fetch';
import { toAnthropicPayload } from '../../protocols/anthropic-messages/request';
import { mapAnthropicStream } from '../../protocols/anthropic-messages/stream';
import { anthropicFetch, API_URL } from './fetch';
import { anthropicErrors, anthropicInfo } from './info';
import { fetchModels } from './models';
import { thinkingOff } from './thinking';

export class AnthropicProvider implements ChatProvider {
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;

  constructor(
    apiKey: string,
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
    clock: Clock = systemClock,
  ) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#clock = clock;
  }

  listModels(signal: AbortSignal): Promise<Model[]> {
    return fetchModels(this.#apiKey, this.#fetch, signal, this.#clock);
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await anthropicFetch(
      this.#fetch,
      this.#apiKey,
      `${API_URL}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          await toAnthropicPayload(
            request,
            request.reasoning === 'off' ? thinkingOff(request.model) : null,
          ),
        ),
        signal,
      },
      this.#clock,
    );

    if (!response.body) throw anthropicErrors.noBody();

    yield* mapAnthropicStream(response.body, anthropicErrors);
  }
}

export const anthropic: ProviderAdapter = {
  info: anthropicInfo,
  create: (apiKey) => new AnthropicProvider(apiKey),
};
