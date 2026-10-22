import {
  AppError,
  messageFor,
  type AppErrorCode,
  type AppErrorOptions,
} from '../../../domain/error';
import { isJsonObject, type Json, type JsonObject } from '../../../domain/json';
import { canonicalUrl, type FetchFailure, type FetchFailureCode } from '../../../domain/web';
import { systemClock, type Clock } from '../../../ports/clock';
import type {
  FetchedPage,
  FetchOutcome,
  SearchHit,
  SearchOutcome,
  ServiceAdapter,
  WebTools,
} from '../../../ports/web-tools';
import { parseRetryAfter, type FetchLike } from '../../http/fetch';
import { tinyfishInfo } from './info';

export const SEARCH_URL = 'https://api.search.tinyfish.ai';
export const FETCH_URL = 'https://api.fetch.tinyfish.ai';

// Tetos do corpo: uma resposta maior é defeito ou abuso e não chega ao Modelo.
const SEARCH_MAX_BYTES = 256 * 1024;
const FETCH_MAX_BYTES = 4 * 1024 * 1024;

// Provisórios até a prova com URLs lentas (`architecture.md` §5): cobrem cabeçalho e corpo.
const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 90_000;
const PER_URL_TIMEOUT_MS = 25_000;

const MESSAGES: Partial<Record<AppErrorCode, string>> = {
  tool_invalid_credential: 'A TinyFish recusou a Chave.',
  tool_quota_exhausted: 'A cota diária da TinyFish acabou; ela volta à meia-noite UTC.',
  tool_unreachable: 'Não foi possível falar com a TinyFish.',
  tool_bad_response: 'A TinyFish enviou uma resposta ilegível.',
};

const toolError = (code: AppErrorCode, options: AppErrorOptions = {}): AppError =>
  new AppError(code, MESSAGES[code] ?? messageFor(code), options);

const codeForStatus = (status: number): AppErrorCode => {
  if (status === 400 || status === 422) return 'tool_invalid_input';
  if (status === 401) return 'tool_invalid_credential';
  if (status === 402) return 'tool_quota_exhausted';
  if (status === 403) return 'tool_forbidden';
  if (status === 429) return 'tool_rate_limited';
  if (status === 404 || status >= 500) return 'tool_unreachable';
  return 'tool_bad_response';
};

/** Lê o corpo até `limit` bytes; passou, cancela a leitura e recusa. */
const readLimited = async (body: ReadableStream<Uint8Array>, limit: number): Promise<string> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw toolError('tool_bad_response', { detail: `corpo acima de ${limit} bytes` });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const ERROR_MAX_BYTES = 16 * 1024;

/** O código do envelope (`INVALID_API_KEY`) serve de detalhe; a mensagem crua nunca chega à UI. */
const envelopeCode = async (response: Response): Promise<string> => {
  if (!response.body) return response.statusText;
  try {
    const body: unknown = JSON.parse(await readLimited(response.body, ERROR_MAX_BYTES));
    if (isJsonObject(body) && isJsonObject(body.error) && typeof body.error.code === 'string') {
      return body.error.code;
    }
  } catch {
    // Corpo ilegível ou grande: o status basta.
  }
  return response.statusText;
};

interface Call {
  url: URL | string;
  init: RequestInit & { headers: Record<string, string> };
  maxBytes: number;
  timeoutMs: number;
}

const textOr = <T extends string | null>(value: Json | undefined, fallback: T): string | T =>
  typeof value === 'string' ? value : fallback;

const isWebUrl = (value: Json | undefined): value is string =>
  typeof value === 'string' && canonicalUrl(value) !== null;

const searchHits = (body: JsonObject): SearchHit[] | null => {
  if (!Array.isArray(body.results)) return null;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const item of body.results) {
    if (!isJsonObject(item)) return null;
    // Fonte só `http(s)`: outro esquema não vira link nem URL elegível. Repetida, a primeira vale.
    if (typeof item.url !== 'string') continue;
    const canonical = canonicalUrl(item.url);
    if (canonical === null || seen.has(canonical)) continue;
    seen.add(canonical);
    hits.push({
      title: textOr(item.title, item.url),
      url: item.url,
      snippet: textOr(item.snippet, ''),
      date: textOr(item.date, null),
    });
  }
  return hits;
};

const FAILURES: Record<string, FetchFailureCode> = {
  page_not_found: 'not_found',
  target_http_error: 'http_error',
  target_unreachable: 'unreachable',
  proxy_error: 'unreachable',
  timeout: 'timeout',
  bot_blocked: 'blocked',
  login_required: 'login_required',
  empty_content: 'empty',
  content_too_large: 'too_large',
  invalid_url: 'rejected',
  invalid_redirect_url: 'rejected',
};

const fetchOutcome = (body: JsonObject): FetchOutcome | null => {
  if (!Array.isArray(body.results) || !Array.isArray(body.errors)) return null;
  const pages: FetchedPage[] = [];
  const failures: FetchFailure[] = [];

  for (const item of body.results) {
    if (!isJsonObject(item) || typeof item.url !== 'string') return null;
    const finalUrl = isWebUrl(item.final_url) ? item.final_url : item.url;
    if (typeof item.text !== 'string' || item.text.trim() === '') {
      failures.push({ url: item.url, code: 'empty' });
      continue;
    }
    pages.push({ finalUrl, title: textOr(item.title, null), text: item.text });
  }
  for (const item of body.errors) {
    if (!isJsonObject(item) || typeof item.url !== 'string') return null;
    const code = typeof item.error === 'string' ? FAILURES[item.error] : undefined;
    failures.push({ url: item.url, code: code === undefined ? 'unknown' : code });
  }
  return { pages, failures };
};

/**
 * Busca e Leitura da TinyFish. A Chave vai só no header `X-API-Key` e só para
 * os dois hosts dela. Cada chamada tem um timeout que cobre cabeçalho e corpo,
 * lê o corpo com teto de bytes e valida a forma do JSON: resposta cortada ou
 * fora do contrato nunca vira resultado parcial.
 */
export class TinyFishTools implements WebTools {
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

  async #send(call: Call, signal: AbortSignal): Promise<{ response: Response; body: string }> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), call.timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);

    // Parar vence o timeout: o abort da pessoa passa intacto.
    const fail = (cause: unknown): never => {
      if (signal.aborted) throw cause;
      if (timeout.signal.aborted) throw toolError('tool_unreachable', { detail: 'timeout', cause });
      if (cause instanceof AppError) throw cause;
      throw toolError('tool_unreachable', { cause });
    };

    try {
      let response: Response;
      try {
        response = await this.#fetch(call.url, {
          ...call.init,
          headers: { ...call.init.headers, 'X-API-Key': this.#apiKey },
          signal: combined,
        });
      } catch (cause) {
        return fail(cause);
      }

      if (!response.ok && response.status !== 400) {
        const code = codeForStatus(response.status);
        throw toolError(code, {
          detail: await envelopeCode(response),
          retryAfterSeconds:
            code === 'tool_rate_limited'
              ? parseRetryAfter(response.headers.get('retry-after'), this.#clock.now())
              : null,
        });
      }
      if (!response.body) throw toolError('tool_bad_response', { detail: 'sem corpo' });

      try {
        return { response, body: await readLimited(response.body, call.maxBytes) };
      } catch (cause) {
        return fail(cause);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(call: Call, signal: AbortSignal): Promise<JsonObject> {
    const { response, body } = await this.#send(call, signal);
    if (response.status === 400) throw toolError('tool_invalid_input', { detail: 'HTTP 400' });

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (cause) {
      throw toolError('tool_bad_response', { detail: 'JSON ilegível', cause });
    }
    if (!isJsonObject(parsed)) throw toolError('tool_bad_response', { detail: 'não é objeto' });
    return parsed;
  }

  async search(query: { text: string; language: string }, signal: AbortSignal): Promise<SearchOutcome> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', query.text);
    url.searchParams.set('language', query.language);

    const body = await this.#json(
      { url, init: { headers: {} }, maxBytes: SEARCH_MAX_BYTES, timeoutMs: SEARCH_TIMEOUT_MS },
      signal,
    );
    const hits = searchHits(body);
    if (hits === null) throw toolError('tool_bad_response', { detail: 'forma da Busca' });
    return { hits };
  }

  async fetch(urls: string[], signal: AbortSignal): Promise<FetchOutcome> {
    const body = await this.#json(
      {
        url: FETCH_URL,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ urls, format: 'markdown', per_url_timeout_ms: PER_URL_TIMEOUT_MS }),
        },
        maxBytes: FETCH_MAX_BYTES,
        timeoutMs: FETCH_TIMEOUT_MS,
      },
      signal,
    );
    const outcome = fetchOutcome(body);
    if (outcome === null) throw toolError('tool_bad_response', { detail: 'forma da Leitura' });
    return outcome;
  }

  /**
   * Busca sem `query`: a TinyFish confere a Chave antes dos parâmetros, então
   * 400 prova a Chave sem gastar cota e 401 a recusa (a confirmar com Chave
   * real, `architecture.md` §5). Cota, limite por minuto e rede recusam sem
   * dizer se a Chave vale.
   */
  async verify(signal: AbortSignal): Promise<void> {
    await this.#send(
      { url: SEARCH_URL, init: { headers: {} }, maxBytes: SEARCH_MAX_BYTES, timeoutMs: SEARCH_TIMEOUT_MS },
      signal,
    );
  }
}

export const tinyfish: ServiceAdapter = {
  info: tinyfishInfo,
  create: (apiKey) => new TinyFishTools(apiKey),
};
