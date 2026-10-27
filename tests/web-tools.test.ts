import { describe, expect, it } from 'vitest';
import { runCalls } from '../src/app/web-tools';
import { FakeWebTools, fixedClock } from './helpers';

describe('runCalls', () => {
  it('lê só as URLs elegíveis e lista as outras como recusadas', async () => {
    const tools = new FakeWebTools();
    tools.fetchAnswer = {
      pages: [{ finalUrl: 'https://a.com/', title: null, text: 'texto' }],
      failures: [],
    };

    const [result] = await runCalls(
      {
        tools,
        clock: fixedClock(0),
        signal: new AbortController().signal,
        language: 'pt',
        space: 40_000,
        conclusion: 0,
        resultTokens: 1_000,
        calls: 0,
        rateLimitedUntil: null,
      },
      [
        {
          type: 'tool_call',
          callId: 't1',
          tool: 'web_fetch',
          input: { urls: ['http://a.com/#segredo', 'https://inventada.com/'] },
        },
      ],
      new Set(['https://a.com/']),
      0,
      false,
    );

    // Sai a forma comparada: o fragmento e o `http` que o Modelo pôs ficam para trás.
    expect(tools.fetches).toEqual([['https://a.com/']]);
    expect(result).toMatchObject({
      sources: [{ title: 'a.com', url: 'https://a.com/' }],
      failures: [{ url: 'https://inventada.com/', code: 'not_eligible' }],
      error: null,
    });
  });
});
