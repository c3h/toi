import { isAbortError, type AppError } from '../../domain/error';
import type { Clock } from '../../ports/clock';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Como um Protocolo traduz falha de rede e resposta não-ok em erro tipado. */
export interface HttpErrors {
  unreachable(cause: unknown): AppError;
  fromResponse(response: Response, now: number): Promise<AppError>;
}

/** `fetch` que devolve só resposta ok; abort passa intacto, o resto vira `AppError`. */
export const fetchOrThrow = async (
  fetchImpl: FetchLike,
  url: URL | string,
  init: RequestInit,
  errors: HttpErrors,
  clock: Clock,
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw errors.unreachable(cause);
  }

  if (!response.ok) throw await errors.fromResponse(response, clock.now());
  return response;
};

export const parseRetryAfter = (header: string | null, now: number): number | null => {
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;

  return Math.max(0, Math.ceil((date - now) / 1000));
};
