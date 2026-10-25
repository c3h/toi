import { describe, expect, it } from 'vitest';
import {
  MAX_RESULT_CHARS,
  MAX_TOOL_CALLS_PER_TURN,
  runCalls,
  searchLanguageOf,
  type ToolTurn,
} from '../src/app/web-tools';
import { appError } from '../src/domain/error';
import type { ToolCallPart } from '../src/domain/message';
import { abortError, FakeWebTools, fixedClock, hit } from './helpers';

const turn = (tools: FakeWebTools, overrides: Partial<ToolTurn> = {}): ToolTurn => ({
  tools,
  clock: fixedClock(0),
  signal: new AbortController().signal,
  language: 'pt',
  space: 40_000,
  conclusion: 0,
  resultTokens: 1_000,
  calls: 0,
  rateLimitedUntil: null,
  ...overrides,
});

/** A Rodada do meio de um turno, com nada usado; o caso dá as URLs elegíveis, o uso e se a próxima é a última. */
const run = (
  state: ToolTurn,
  calls: ToolCallPart[],
  { eligible = [], used = 0, last = false }: { eligible?: string[]; used?: number; last?: boolean } = {},
) => runCalls(state, calls, new Set(eligible), used, last);

const searchCall = (callId: string, input: ToolCallPart['input'] = { query: 'cobre' }): ToolCallPart => ({
  type: 'tool_call',
  callId,
  tool: 'web_search',
  input,
});

const fetchCall = (callId: string, urls: string[]): ToolCallPart => ({
  type: 'tool_call',
  callId,
  tool: 'web_fetch',
  input: { urls },
});

describe('searchLanguageOf', () => {
  it('usa o idioma do navegador quando a Busca o aceita e inglês fora disso', () => {
    expect(searchLanguageOf('pt-BR')).toBe('pt');
    expect(searchLanguageOf('EN')).toBe('en');
    expect(searchLanguageOf('ca-ES')).toBe('en');
  });
});

describe('runCalls', () => {
  it('busca no idioma default e devolve as Fontes e o texto para o Modelo', async () => {
    const tools = new FakeWebTools();
    tools.searchAnswer = { hits: [hit('https://a.com/', 'Cobre hoje')] };

    const [result] = await run(turn(tools), [searchCall('t1')]);

    expect(tools.searches).toEqual([{ text: 'cobre', language: 'pt' }]);
    expect(result).toMatchObject({
      callId: 't1',
      sources: [{ title: 'Cobre hoje', url: 'https://a.com/' }],
      error: null,
    });
    expect(result!.content).toContain('URL: https://a.com/');
  });

  it.each<{ caso: string; input: ToolCallPart['input'] }>([
    { caso: 'consulta vazia', input: { query: '  ' } },
    { caso: 'idioma fora da lista', input: { query: 'x', language: 'xx' } },
  ])('recusa $caso sem rede', async ({ input }) => {
    const tools = new FakeWebTools();

    const [result] = await run(turn(tools), [searchCall('t1', input)]);

    expect(tools.searches).toEqual([]);
    expect(result!.error?.code).toBe('tool_invalid_input');
  });

  it('lê só as URLs elegíveis e lista as outras como recusadas', async () => {
    const tools = new FakeWebTools();
    tools.fetchAnswer = {
      pages: [{ finalUrl: 'https://a.com/', title: null, text: 'texto' }],
      failures: [],
    };

    const [result] = await run(
      turn(tools),
      [fetchCall('t1', ['http://a.com/#segredo', 'https://inventada.com/'])],
      { eligible: ['https://a.com/'] },
    );

    // Sai a forma comparada: o fragmento e o `http` que o Modelo pôs ficam para trás.
    expect(tools.fetches).toEqual([['https://a.com/']]);
    expect(result).toMatchObject({
      sources: [{ title: 'a.com', url: 'https://a.com/' }],
      failures: [{ url: 'https://inventada.com/', code: 'not_eligible' }],
      error: null,
    });
  });

  it('nenhuma URL elegível vira erro sem rede', async () => {
    const tools = new FakeWebTools();

    const [result] = await run(turn(tools), [fetchCall('t1', ['https://x.com/'])]);

    expect(tools.fetches).toEqual([]);
    expect(result!.error?.code).toBe('tool_url_not_eligible');
  });

  it('corta a página longa no teto do resultado', async () => {
    const tools = new FakeWebTools();
    tools.fetchAnswer = {
      pages: [
        { finalUrl: 'https://a.com/', title: 'A', text: 'x'.repeat(50_000) },
      ],
      failures: [],
    };

    const [result] = await run(turn(tools), [fetchCall('t1', ['https://a.com/'])], {
      eligible: ['https://a.com/'],
    });

    expect(result!.content.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(result!.content).toContain('[truncated]');
  });

  it('acima do teto do turno responde tool_call_limit sem rede', async () => {
    const tools = new FakeWebTools();
    const state = turn(tools, { calls: MAX_TOOL_CALLS_PER_TURN - 1 });

    const results = await run(state, [searchCall('t1'), searchCall('t2')]);

    expect(tools.searches).toHaveLength(1);
    expect(results.map((result) => result.error?.code ?? null)).toEqual([null, 'tool_call_limit']);
    expect(state.calls).toBe(MAX_TOOL_CALLS_PER_TURN + 1);
  });

  it('só executa as chamadas cujo resultado no teto cabe no espaço que sobra', async () => {
    const tools = new FakeWebTools();

    const results = await run(turn(tools), [searchCall('t1'), searchCall('t2'), searchCall('t3')], {
      used: 38_000,
    });

    expect(tools.searches).toHaveLength(2);
    expect(results.map((result) => result.error?.code ?? null)).toEqual([
      null,
      null,
      'tool_call_limit',
    ]);
  });

  it('antes da última Rodada nenhuma chamada sai', async () => {
    const tools = new FakeWebTools();

    const [result] = await run(turn(tools), [searchCall('t1')], { last: true });

    expect(tools.searches).toEqual([]);
    expect(result!.error?.code).toBe('tool_call_limit');
  });

  it('depois de um 429 segura as chamadas seguintes até o retry-after', async () => {
    const tools = new FakeWebTools();
    tools.searchAnswer = appError('tool_rate_limited', { retryAfterSeconds: 30 });
    const clock = fixedClock(0);
    const state = turn(tools, { clock });

    await run(state, [searchCall('t1')]);
    clock.set(10_000);
    const [held] = await run(state, [searchCall('t2')]);

    expect(tools.searches).toHaveLength(1);
    expect(held!.error).toMatchObject({ code: 'tool_rate_limited', retryAfterSeconds: 20 });
  });

  it('erro do Serviço vira resultado com erro tipado e dica ao Modelo', async () => {
    const tools = new FakeWebTools();
    tools.searchAnswer = appError('tool_quota_exhausted');

    const [result] = await run(turn(tools), [searchCall('t1')]);

    expect(result!.error?.code).toBe('tool_quota_exhausted');
    expect(result!.content).toMatch(/^Error: /);
  });

  it('com abort espera todas as chamadas e repassa o abort', async () => {
    const controller = new AbortController();
    const tools = new FakeWebTools();
    let finished = 0;
    tools.searchAnswer = (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          finished += 1;
          reject(abortError());
        });
      });

    const pending = run(turn(tools, { signal: controller.signal }), [searchCall('t1'), searchCall('t2')]);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(finished).toBe(2);
  });
});
