import { describe, expect, it } from 'vitest';
import { startSendMessage, type RunDeps, type SendOptions } from '../src/app/send-message';
import { MAX_ROUNDS } from '../src/app/web-tools';
import type { StreamEvent } from '../src/domain/stream';
import { WEB_FETCH, WEB_SEARCH } from '../src/domain/web';
import {
  abortError,
  baseDeps,
  expectCachedPrefix,
  FakeWebTools,
  hit,
  round,
  ScriptedProvider,
  sendInput,
  textEvents,
  toolCall,
} from './helpers';

const searching = (callId = 't1', query = 'cobre'): StreamEvent[] =>
  round(
    [
      { type: 'part_started', index: 0, part: { type: 'reasoning' } },
      { type: 'delta', index: 0, part: 'reasoning', text: 'preciso buscar' },
      { type: 'delta', index: 0, part: 'signature', text: 'sig' },
      { type: 'part_finished', index: 0 },
      ...toolCall(1, callId, WEB_SEARCH, JSON.stringify({ query })),
    ],
    'tool_use',
  );

const answering = (text = 'O cobre subiu.'): StreamEvent[] => round(textEvents(text), 'end_turn', 7);

/** Uma Rodada sem raciocínio que escreve antes de buscar, com o espaço que o Modelo deixa no fim. */
const narrating = (callId = 't1', query = 'cobre'): StreamEvent[] =>
  round(
    [...textEvents('Vou buscar.\n\n'), ...toolCall(1, callId, WEB_SEARCH, JSON.stringify({ query }))],
    'tool_use',
  );

const send = async (deps: RunDeps, overrides: Partial<SendOptions> = {}) =>
  (await startSendMessage(deps, { ...sendInput(), signal: new AbortController().signal, ...overrides }))
    .result;

const setup = async (rounds: StreamEvent[][]) => {
  const built = await baseDeps();
  const provider = new ScriptedProvider({ rounds });
  const tools = new FakeWebTools();
  return { ...built, provider, tools, run: { ...built.deps, provider, tools } };
};

describe('laço de Rodadas', () => {
  it('busca, devolve o resultado com o raciocínio e fecha com a resposta', async () => {
    const { provider, tools, run, store } = await setup([searching(), answering()]);
    tools.searchAnswer = { hits: [hit('https://a.com/cobre', 'Cobre')] };

    const { message } = await send(run);

    expect(message.status).toBe('complete');
    expect(message.stopReason).toBe('end_turn');
    expect(message.parts.map((part) => part.type)).toEqual([
      'reasoning',
      'tool_call',
      'tool_result',
      'text',
    ]);
    expect(message.usage).toMatchObject({ inputTokens: 20, outputTokens: 12 });
    expect(tools.searches).toEqual([{ text: 'cobre', language: 'pt' }]);

    expect(provider.requests[0]!.tools.map(({ name }) => name)).toEqual([WEB_SEARCH, WEB_FETCH]);
    expect(provider.requests[1]!.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'preciso buscar', signature: 'sig' },
          { type: 'tool_call', callId: 't1', tool: WEB_SEARCH, input: { query: 'cobre' } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            type: 'tool_result',
            callId: 't1',
            content: expect.stringContaining('https://a.com/cobre'),
            isError: false,
          },
        ],
      },
    ]);
    expect((await store.listMessages('c1')).at(-1)).toEqual(message);
  });

  it('para no teto de Rodadas com tool_limit', async () => {
    const rounds = Array.from({ length: MAX_ROUNDS }, (_, index) => searching(`t${index}`));
    const { run, provider, tools } = await setup(rounds);

    const { message } = await send(run);

    expect(provider.requests).toHaveLength(MAX_ROUNDS);
    // A penúltima Rodada já não executa: a última é para concluir.
    expect(tools.searches).toHaveLength(MAX_ROUNDS - 2);
    expect(message.status).toBe('failed');
    expect(message.error?.code).toBe('tool_limit');
  });

  it('cada Rodada reenvia a anterior inteira e só cresce no fim', async () => {
    const { provider, run } = await setup([searching('t1'), narrating('t2', 'ouro'), answering()]);

    await send(run);

    expect(provider.requests).toHaveLength(3);
    await expectCachedPrefix(provider.requests[0]!, provider.requests[1]!);
    await expectCachedPrefix(provider.requests[1]!, provider.requests[2]!);
  });

  it('sem raciocínio, o turno seguinte começa pela última Rodada inteira', async () => {
    const { provider, run } = await setup([narrating(), answering(), answering('O ouro caiu.')]);

    await send(run);
    await send(run, { text: 'E o ouro?' });

    await expectCachedPrefix(provider.requests[1]!, provider.requests[2]!);
  });

  it('parar durante a Ferramenta interrompe e guarda o que já veio', async () => {
    const controller = new AbortController();
    const { run, tools } = await setup([searching()]);
    tools.searchAnswer = (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
        controller.abort();
      });

    const { message } = await send(run, { signal: controller.signal });

    expect(message.status).toBe('interrupted');
    expect(message.error).toBeNull();
    expect(message.parts.map((part) => part.type)).toEqual(['reasoning', 'tool_call']);
  });
});
