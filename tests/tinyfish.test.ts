import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/adapters/http/fetch';
import { TinyFishTools } from '../src/adapters/services/tinyfish/tools';
import { fixedClock, jsonResponse } from './helpers';

describe('TinyFishTools.search', () => {
  it('manda a Chave no header e devolve só Fontes http(s), sem repetir', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(200, {
        results: [
          { title: 'Cobre', url: 'https://a.com/cobre', snippet: 'preço', date: '2026-10-01' },
          { url: 'https://b.com/', snippet: 'sem título' },
          { title: 'Arquivo', url: 'ftp://c.com/x', snippet: '' },
          { title: 'Cobre de novo', url: 'http://a.com/cobre#topo', snippet: 'repetida' },
        ],
      });
    };

    const outcome = await new TinyFishTools('tf-key', fetchImpl, fixedClock(0)).search(
      { text: 'cobre', language: 'pt' },
      new AbortController().signal,
    );

    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe('https://api.search.tinyfish.ai');
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'cobre', language: 'pt' });
    expect(calls[0]!.init?.headers).toMatchObject({ 'X-API-Key': 'tf-key' });
    expect(outcome.hits).toEqual([
      { title: 'Cobre', url: 'https://a.com/cobre', snippet: 'preço', date: '2026-10-01' },
      { title: 'https://b.com/', url: 'https://b.com/', snippet: 'sem título', date: null },
    ]);
  });
});
