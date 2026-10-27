import { describe, expect, it } from 'vitest';
import {
  startRetryMessage,
  startSendMessage,
  type RetryOptions,
  type RunDeps,
  type RunResult,
  type SendOptions,
} from '../src/app/send-message';
import { AppError } from '../src/domain/error';
import { textOf } from '../src/domain/message';
import type { StreamEvent } from '../src/domain/stream';
import {
  abortError,
  baseDeps,
  expectCachedPrefix,
  FailingWrites,
  gatedProvider,
  imageFile,
  replyEvents,
  ScriptedProvider,
  sendInput,
  testModel,
  textFile,
  usage,
} from './helpers';

const successEvents = (): StreamEvent[] => [
  { type: 'started', model: testModel.id, usage: usage(10, 0) },
  { type: 'part_started', index: 0, part: { type: 'text' } },
  { type: 'delta', index: 0, part: 'text', text: 'Olá' },
  { type: 'delta', index: 0, part: 'text', text: ', mundo' },
  { type: 'part_finished', index: 0 },
  { type: 'usage', usage: usage(10, 5), stopReason: 'end_turn' },
  { type: 'finished' },
];

const ask = (overrides: Partial<SendOptions> = {}): SendOptions => ({
  ...sendInput(),
  signal: new AbortController().signal,
  ...overrides,
});

const sendMessage = async (deps: RunDeps, options: SendOptions): Promise<RunResult> =>
  (await startSendMessage(deps, options)).result;

const retryMessage = async (deps: RunDeps, options: RetryOptions): Promise<RunResult> =>
  (await startRetryMessage(deps, options)).result;

describe('sendMessage', () => {
  it('persiste user e assistant, faz streaming e fecha em complete', async () => {
    const { store, deps } = await baseDeps();
    const provider = new ScriptedProvider(successEvents());

    const result = await sendMessage({ ...deps, provider }, ask());

    expect(result.message.status).toBe('complete');
    expect(textOf(result.message)).toBe('Olá, mundo');
    expect(result.message.usage?.outputTokens).toBe(5);
    expect(result.message.stopReason).toBe('end_turn');
    expect(result.truncated).toBeNull();
    expect(result.persistError).toBeNull();

    const messages = await store.listMessages('c1');
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages.map((message) => message.seq)).toEqual([1, 2]);

    const conversation = await store.getConversation('c1');
    expect(conversation?.title).toBe('Pergunta');

    expect(provider.requests[0]).toEqual({
      model: testModel.id,
      maxTokens: 8_192,
      effort: 'low',
      reasoning: 'on',
      system: null,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Pergunta' }] }],
      tools: [],
    });
  });

  it('marca interrupted e preserva o texto parcial quando a pessoa para', async () => {
    const { deps } = await baseDeps();
    const controller = new AbortController();
    const { provider, delta } = gatedProvider('parcial');

    const promise = sendMessage({ ...deps, provider }, ask({ signal: controller.signal }));

    await delta;
    controller.abort();

    const result = await promise;

    expect(result.message.status).toBe('interrupted');
    expect(textOf(result.message)).toBe('parcial');
    expect(result.message.error).toBeNull();
  });

  it('marca failed com AppError tipado', async () => {
    const { deps } = await baseDeps();

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
      throw new AppError('overloaded', 'O Modelo está sobrecarregado.');
    });

    const result = await sendMessage({ ...deps, provider }, ask());

    expect(result.message.status).toBe('failed');
    expect(result.message.error?.code).toBe('overloaded');
  });

  it('não reabre uma Mensagem finalizada quando o corpo falha depois de finished', async () => {
    const { deps } = await baseDeps();

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield* successEvents();
      throw abortError();
    });

    const result = await sendMessage({ ...deps, provider }, ask());

    expect(result.message.status).toBe('complete');
    expect(result.message.error).toBeNull();
    expect(textOf(result.message)).toBe('Olá, mundo');
  });

  it('expõe falha de persistência sem derrubar o Fluxo', async () => {
    const store = new FailingWrites();
    const { deps } = await baseDeps(store);

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      for (const event of replyEvents('ok')) {
        // A resposta chega inteira; só o flush final falha.
        if (event.type === 'finished') store.failing = true;
        yield event;
      }
    });

    const result = await sendMessage({ ...deps, provider }, ask());

    expect(result.message.status).toBe('complete');
    expect(textOf(result.message)).toBe('ok');
    expect(result.persistError?.code).toBe('storage_failed');
  });

  it('retry substitui a última Mensagem do assistant em vez de duplicar', async () => {
    const { store, deps } = await baseDeps();
    let failing = true;

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      if (failing) {
        yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
        throw new AppError('overloaded', 'O Modelo está sobrecarregado.');
      }

      yield* successEvents();
    });

    const first = await sendMessage({ ...deps, provider }, ask());

    failing = false;

    const retried = await retryMessage(
      { ...deps, provider },
      {
        conversationId: 'c1',
        messageId: first.message.id,
        model: testModel,
        effort: 'low',
        signal: new AbortController().signal,
      },
    );

    expect(retried.message.id).toBe(first.message.id);
    expect(retried.message.status).toBe('complete');
    expect(textOf(retried.message)).toBe('Olá, mundo');

    const messages = await store.listMessages('c1');
    expect(messages).toHaveLength(2);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(messages[1]?.id).toBe(first.message.id);

    expect(provider.requests[1]?.messages).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'Pergunta' }] },
    ]);
  });
});

describe('cache de prompt', () => {
  it.each([
    { caso: 'só texto', attachments: [] },
    { caso: 'com Anexos', attachments: [imageFile('i1', 3), textFile('t1', '# notas')] },
  ])('o envio seguinte começa pelo pedido anterior inteiro ($caso)', async ({ attachments }) => {
    const { deps } = await baseDeps();
    const provider = new ScriptedProvider(successEvents());
    const run = { ...deps, provider };

    await sendMessage(run, ask({ attachments }));
    await sendMessage(run, ask({ text: 'E depois?' }));

    await expectCachedPrefix(provider.requests[0]!, provider.requests[1]!);
  });
});
