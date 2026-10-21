import { AppError } from '../../domain/error';
import type { Model } from '../../domain/model';
import type { StreamEvent } from '../../domain/stream';
import { systemClock, type Clock } from '../../ports/clock';
import type { ChatProvider, ChatRequest } from '../../ports/chat-provider';
import { anthropicFetch, type FetchLike } from './fetch';
import { fetchModels } from './models';
import { toAnthropicPayload } from './request';
import { mapAnthropicStream } from './stream';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

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
      MESSAGES_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toAnthropicPayload(request)),
        signal,
      },
      this.#clock,
    );

    if (!response.body) throw new AppError('unknown', 'A Anthropic respondeu sem corpo.');

    yield* mapAnthropicStream(response.body);
  }
}
