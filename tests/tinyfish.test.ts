import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/adapters/http/fetch';
import { FETCH_URL, TinyFishTools } from '../src/adapters/services/tinyfish/tools';
import { abortError, fixedClock, jsonResponse } from './helpers';

const signal = () => new AbortController().signal;

const tools = (fetchImpl: FetchLike) => new TinyFishTools('tf-key', fetchImpl, fixedClock(0));

/** Responde sempre com `response` e guarda o que foi pedido. */
const replying = (response: () => Response) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { calls, fetchImpl };
};

/** Só termina quando o sinal da chamada aborta. */
const hanging: FetchLike = (_, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });

const envelope = (code: string) => ({ error: { code, message: 'mensagem crua' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('TinyFishTools.search', () => {
  it('manda a Chave no header e devolve só Fontes http(s), sem repetir', async () => {
    const { calls, fetchImpl } = replying(() =>
      jsonResponse(200, {
        results: [
          { title: 'Cobre', url: 'https://a.com/cobre', snippet: 'preço', date: '2026-10-01' },
          { url: 'https://b.com/', snippet: 'sem título' },
          { title: 'Arquivo', url: 'ftp://c.com/x', snippet: '' },
          { title: 'Cobre de novo', url: 'http://a.com/cobre#topo', snippet: 'repetida' },
        ],
      }),
    );

    const outcome = await tools(fetchImpl).search({ text: 'cobre', language: 'pt' }, signal());

    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe('https://api.search.tinyfish.ai');
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'cobre', language: 'pt' });
    expect(calls[0]!.init?.headers).toMatchObject({ 'X-API-Key': 'tf-key' });
    expect(outcome.hits).toEqual([
      { title: 'Cobre', url: 'https://a.com/cobre', snippet: 'preço', date: '2026-10-01' },
      { title: 'https://b.com/', url: 'https://b.com/', snippet: 'sem título', date: null },
    ]);
  });

  it.each([
    { status: 400, code: 'tool_invalid_input' },
    { status: 401, code: 'tool_invalid_credential' },
    { status: 402, code: 'tool_quota_exhausted' },
    { status: 403, code: 'tool_forbidden' },
    { status: 404, code: 'tool_unreachable' },
    { status: 422, code: 'tool_invalid_input' },
    { status: 503, code: 'tool_unreachable' },
  ])('HTTP $status vira $code sem a mensagem crua', async ({ status, code }) => {
    const { fetchImpl } = replying(() => jsonResponse(status, envelope('SOME_CODE')));

    const error = await tools(fetchImpl)
      .search({ text: 'x', language: 'en' }, signal())
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code });
    expect(String((error as Error).message)).not.toContain('mensagem crua');
  });

  it('429 traz o retry-after', async () => {
    const { fetchImpl } = replying(() =>
      jsonResponse(429, envelope('RATE_LIMITED'), { 'retry-after': '12' }),
    );

    await expect(tools(fetchImpl).search({ text: 'x', language: 'en' }, signal())).rejects.toMatchObject({
      code: 'tool_rate_limited',
      retryAfterSeconds: 12,
    });
  });

  it.each([
    { caso: 'JSON ilegível', body: () => new Response('<html>', { status: 200 }) },
    { caso: 'sem results', body: () => jsonResponse(200, { hits: [] }) },
    { caso: 'item que não é objeto', body: () => jsonResponse(200, { results: ['x'] }) },
    {
      caso: 'corpo acima do teto',
      body: () => new Response(new Uint8Array(256 * 1024 + 1), { status: 200 }),
    },
  ])('$caso vira tool_bad_response', async ({ body }) => {
    const { fetchImpl } = replying(body);

    await expect(tools(fetchImpl).search({ text: 'x', language: 'en' }, signal())).rejects.toMatchObject({
      code: 'tool_bad_response',
    });
  });

  it('o timeout vira tool_unreachable', async () => {
    vi.useFakeTimers();
    const pending = tools(hanging).search({ text: 'x', language: 'en' }, signal());
    const settled = pending.catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(await settled).toMatchObject({ code: 'tool_unreachable', detail: 'timeout' });
  });

  it('parar a resposta passa o abort intacto', async () => {
    const controller = new AbortController();
    const pending = tools(hanging).search({ text: 'x', language: 'en' }, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('TinyFishTools.fetch', () => {
  it('pede markdown e separa páginas lidas, vazias e com falha', async () => {
    const { calls, fetchImpl } = replying(() =>
      jsonResponse(200, {
        results: [
          { url: 'https://a.com/', final_url: 'https://a.com/home', title: 'A', text: '# A' },
          { url: 'https://b.com/', final_url: null, title: null, text: '   ' },
        ],
        errors: [
          { url: 'https://c.com/', error: 'bot_blocked' },
          { url: 'https://d.com/', error: 'algo_novo' },
        ],
      }),
    );

    const outcome = await tools(fetchImpl).fetch(['https://a.com/'], signal());

    expect(calls[0]!.url).toBe(FETCH_URL);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      urls: ['https://a.com/'],
      format: 'markdown',
      per_url_timeout_ms: 25_000,
    });
    expect(outcome).toEqual({
      pages: [{ finalUrl: 'https://a.com/home', title: 'A', text: '# A' }],
      failures: [
        { url: 'https://b.com/', code: 'empty' },
        { url: 'https://c.com/', code: 'blocked' },
        { url: 'https://d.com/', code: 'unknown' },
      ],
    });
  });

  it('sem errors vira tool_bad_response', async () => {
    const { fetchImpl } = replying(() => jsonResponse(200, { results: [] }));

    await expect(tools(fetchImpl).fetch(['https://a.com/'], signal())).rejects.toMatchObject({
      code: 'tool_bad_response',
    });
  });
});

describe('TinyFishTools.verify', () => {
  it('aceita a Chave quando a Busca sem consulta responde 400', async () => {
    const { calls, fetchImpl } = replying(() => jsonResponse(400, envelope('MISSING_QUERY')));

    await expect(tools(fetchImpl).verify(signal())).resolves.toBeUndefined();
    expect(new URL(calls[0]!.url).searchParams.has('query')).toBe(false);
  });

  it('recusa a Chave com 401', async () => {
    const { fetchImpl } = replying(() => jsonResponse(401, envelope('INVALID_API_KEY')));

    await expect(tools(fetchImpl).verify(signal())).rejects.toMatchObject({
      code: 'tool_invalid_credential',
      detail: 'INVALID_API_KEY',
    });
  });
});
