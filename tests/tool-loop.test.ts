import { describe, expect, it } from 'vitest';
import { startSendMessage, type RunDeps, type SendOptions } from '../src/app/send-message';
import { MAX_ROUNDS } from '../src/app/web-tools';
import { appError } from '../src/domain/error';
import type { Model } from '../src/domain/model';
import type { StreamEvent } from '../src/domain/stream';
import type { StopReason } from '../src/domain/usage';
import { WEB_FETCH, WEB_SEARCH } from '../src/domain/web';
import type { ChatProvider, ChatRequest } from '../src/ports/chat-provider';
import {
  abortError,
  baseDeps,
  FakeWebTools,
  hit,
  MemorySettingsStore,
  sendInput,
  testModel,
  usage,
} from './helpers';

/** Um Provedor que responde cada Rodada com o script seguinte. */
class RoundsProvider implements ChatProvider {
  readonly requests: ChatRequest[] = [];
  readonly #rounds: StreamEvent[][];

  constructor(rounds: StreamEvent[][]) {
    this.#rounds = rounds;
  }

  async listModels(): Promise<Model[]> {
    return [testModel];
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const events = this.#rounds[this.requests.length];
    this.requests.push(request);
    if (events === undefined) throw new Error('Rodada fora do script.');
    for (const event of events) {
      if (signal.aborted) throw abortError();
      yield event;
    }
  }
}

const toolCall = (index: number, callId: string, tool: string, json: string): StreamEvent[] => [
  { type: 'part_started', index, part: { type: 'tool_call', callId, tool } },
  { type: 'delta', index, part: 'input', text: json },
  { type: 'part_finished', index },
];

const round = (
  body: StreamEvent[],
  stopReason: StopReason,
  output = 5,
): StreamEvent[] => [
  { type: 'started', model: testModel.id, usage: usage(10, 0) },
  ...body,
  { type: 'usage', usage: usage(10, output), stopReason },
  { type: 'finished' },
];

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

const answering = (text = 'O cobre subiu.'): StreamEvent[] =>
  round([{ type: 'delta', index: 0, part: 'text', text }], 'end_turn', 7);

const send = async (deps: RunDeps, overrides: Partial<SendOptions> = {}) =>
  (await startSendMessage(deps, { ...sendInput(), signal: new AbortController().signal, ...overrides }))
    .result;

const setup = async (rounds: StreamEvent[][]) => {
  const built = await baseDeps();
  const provider = new RoundsProvider(rounds);
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

  it('sem Serviço não oferece Ferramentas', async () => {
    const { provider, run } = await setup([answering()]);

    await send({ ...run, tools: null });

    expect(provider.requests[0]!.tools).toEqual([]);
  });

  it('Leitura de URL que a Busca da mesma Rodada achou é recusada; na Rodada seguinte, lida', async () => {
    const url = 'https://a.com/cobre';
    const { tools, run } = await setup([
      round(
        [
          ...toolCall(0, 't1', WEB_SEARCH, '{"query":"cobre"}'),
          ...toolCall(1, 't2', WEB_FETCH, JSON.stringify({ urls: [url] })),
        ],
        'tool_use',
      ),
      round(toolCall(0, 't3', WEB_FETCH, JSON.stringify({ urls: [url] })), 'tool_use'),
      answering(),
    ]);
    tools.searchAnswer = { hits: [hit(url)] };
    tools.fetchAnswer = {
      pages: [{ finalUrl: url, title: 'Cobre', text: 'texto' }],
      failures: [],
    };

    const { message } = await send(run);

    const errors = message.parts.flatMap((part) =>
      part.type === 'tool_result' ? [part.error?.code ?? null] : [],
    );
    expect(errors).toEqual([null, 'tool_url_not_eligible', null]);
    expect(tools.fetches).toEqual([[url]]);
  });

  it('com o espaço escolhido cheio, a chamada seguinte recebe tool_call_limit sem rede', async () => {
    const { run, tools } = await setup([searching('t1'), searching('t2'), answering()]);
    const settings = new MemorySettingsStore();
    await settings.saveToolSpace(20_000);
    // Um token por caractere: um resultado no teto pesa 15 mil, a conclusão guarda mil, e o
    // primeiro resultado ocupa 14 mil.
    const estimator = { estimate: (text: string) => text.length, estimateAttachment: () => 1 };
    tools.searchAnswer = { hits: [{ ...hit('https://a.com/'), snippet: 'x'.repeat(14_000) }] };

    const { message } = await send(
      { ...run, settings, estimator },
      { model: { ...testModel, maxTokens: 1_000 } },
    );

    expect(tools.searches).toHaveLength(1);
    const errors = message.parts.flatMap((part) =>
      part.type === 'tool_result' ? [part.error?.code ?? null] : [],
    );
    expect(errors).toEqual([null, 'tool_call_limit']);
    expect(message.status).toBe('complete');
  });

  it('conta o raciocínio pelo uso e fecha em tool_limit quando o Modelo insiste além do espaço', async () => {
    // Cada Rodada declara 6 mil tokens de saída, embora o texto dela seja curto.
    const insisting = (callId: string) =>
      round(toolCall(0, callId, WEB_SEARCH, '{"query":"cobre"}'), 'tool_use', 6_000);
    const { run, tools, provider } = await setup([
      insisting('t1'),
      insisting('t2'),
      insisting('t3'),
      insisting('t4'),
    ]);
    const settings = new MemorySettingsStore();
    await settings.saveToolSpace(20_000);

    const { message } = await send({ ...run, settings }, { model: { ...testModel, maxTokens: 1_000 } });

    expect(tools.searches).toHaveLength(3);
    expect(provider.requests).toHaveLength(4);
    expect(message.status).toBe('failed');
    expect(message.error?.code).toBe('tool_limit');
  });

  it('erro do Serviço vira resultado e a resposta segue', async () => {
    const { run, tools } = await setup([searching(), answering('Sem busca, respondo assim.')]);
    tools.searchAnswer = appError('tool_quota_exhausted');

    const { message } = await send(run);

    expect(message.status).toBe('complete');
    const result = message.parts.find((part) => part.type === 'tool_result');
    expect(result).toMatchObject({ error: { code: 'tool_quota_exhausted' } });
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

  it('max_tokens no meio da chamada fecha a resposta sem a chamada', async () => {
    const { run, tools } = await setup([
      round(
        [
          { type: 'delta', index: 0, part: 'text', text: 'vou buscar' },
          { type: 'part_started', index: 1, part: { type: 'tool_call', callId: 't1', tool: WEB_SEARCH } },
          { type: 'delta', index: 1, part: 'input', text: '{"query":' },
        ],
        'max_tokens',
      ),
    ]);

    const { message } = await send(run);

    expect(message.status).toBe('complete');
    expect(message.stopReason).toBe('max_tokens');
    expect(message.parts).toEqual([{ type: 'text', text: 'vou buscar' }]);
    expect(tools.searches).toEqual([]);
  });

  it('tool_use com chamada quebrada falha sem executar nada', async () => {
    const { run, tools } = await setup([
      round(
        [
          { type: 'part_started', index: 0, part: { type: 'tool_call', callId: 't1', tool: WEB_SEARCH } },
          { type: 'delta', index: 0, part: 'input', text: '{"query":' },
          { type: 'part_finished', index: 0 },
        ],
        'tool_use',
      ),
    ]);

    const { message } = await send(run);

    expect(message.status).toBe('failed');
    expect(tools.searches).toEqual([]);
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
