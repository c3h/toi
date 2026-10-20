import { isAbortError } from '../../domain/error';
import { errorFromResponse, unreachableError } from './error';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const anthropicFetch = async (
  fetchImpl: FetchLike,
  apiKey: string,
  url: URL | string,
  init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        ...init.headers,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw unreachableError(cause);
  }

  if (!response.ok) throw await errorFromResponse(response);
  return response;
};
