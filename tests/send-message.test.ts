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
import { textOf, type Message } from '../src/domain/message';
import type { StreamEvent } from '../src/domain/stream';
import {
  abortError,
  baseDeps,
  deferred,
  imageFile,
  MemoryStore,
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

    const result = await sendMessage(
      { ...deps, tools: null, provider },
      ask(),
    );

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
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Pergunta' }] }],
      tools: [],
    });
  });

  it('marca interrupted e preserva o texto parcial quando a pessoa para', async () => {
    const { deps } = await baseDeps();
    const controller = new AbortController();

    let signalFirstDelta: () => void = () => undefined;
    const firstDelta = new Promise<void>((resolve) => {
      signalFirstDelta = resolve;
    });

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
      yield { type: 'part_started', index: 0, part: { type: 'text' } };
      yield { type: 'delta', index: 0, part: 'text', text: 'parcial' };

      if (controller.signal.aborted) throw abortError();
      await new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    });

    const promise = sendMessage(
      {
        ...deps,
        tools: null,
        provider,
        onUpdate: (message) => {
          if (textOf(message) === 'parcial') signalFirstDelta();
        },
      },
      ask({ signal: controller.signal }),
    );

    await firstDelta;
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

    const result = await sendMessage(
      { ...deps, tools: null, provider },
      ask(),
    );

    expect(result.message.status).toBe('failed');
    expect(result.message.error?.code).toBe('overloaded');
  });

  it('não reabre uma Mensagem finalizada quando o corpo falha depois de finished', async () => {
    const { deps } = await baseDeps();

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield* successEvents();
      throw abortError();
    });

    const result = await sendMessage(
      { ...deps, tools: null, provider },
      ask(),
    );

    expect(result.message.status).toBe('complete');
    expect(result.message.error).toBeNull();
    expect(textOf(result.message)).toBe('Olá, mundo');
  });

  it('expõe falha de persistência sem derrubar o Fluxo', async () => {
    class FailingStore extends MemoryStore {
      fail = false;

      override async putMessage(message: Message): Promise<void> {
        if (this.fail) throw new Error('disco cheio');
        await super.putMessage(message);
      }
    }

    const store = new FailingStore();
    const { deps } = await baseDeps(store);

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
      yield { type: 'delta', index: 0, part: 'text', text: 'ok' };
      store.fail = true;
      yield { type: 'finished' };
    });

    const result = await sendMessage(
      { ...deps, tools: null, provider },
      ask(),
    );

    expect(result.message.status).toBe('complete');
    expect(textOf(result.message)).toBe('ok');
    expect(result.persistError?.code).toBe('storage_failed');
  });

  it('marca o primeiro token no primeiro delta de qualquer Parte e não o move depois', async () => {
    const { store, deps, clock } = await baseDeps();

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
      clock.set(50_800);
      yield { type: 'delta', index: 0, part: 'reasoning', text: 'pensando' };
      clock.set(51_000);
      yield { type: 'delta', index: 1, part: 'text', text: 'oi' };
      yield { type: 'usage', usage: usage(3, 4), stopReason: 'end_turn' };
      yield { type: 'finished' };
      clock.set(52_000);
    });

    const result = await sendMessage(
      { ...deps, tools: null, provider },
      ask(),
    );

    expect(result.message).toMatchObject({
      createdAt: 50_000,
      firstTokenAt: 50_800,
      completedAt: 52_000,
    });
    expect((await store.getMessage(result.message.id))?.firstTokenAt).toBe(50_800);
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

    const first = await sendMessage(
      { ...deps, tools: null, provider },
      ask(),
    );

    failing = false;

    const retried = await retryMessage(
      { ...deps, tools: null, provider },
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

  it('retry grava o destino novo antes da rede, mesmo se falhar antes de started', async () => {
    const { store, deps } = await baseDeps();
    const first = await sendMessage(
      { ...deps, tools: null, provider: new ScriptedProvider(successEvents()) },
      ask(),
    );

    const other = { ...testModel, id: 'claude-outro' };
    const unreachable = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      throw new AppError('unreachable', 'Não foi possível falar com a Anthropic.');
    });

    const retried = await retryMessage(
      { ...deps, tools: null, provider: unreachable },
      {
        conversationId: 'c1',
        messageId: first.message.id,
        model: other,
        effort: 'low',
        signal: new AbortController().signal,
      },
    );

    expect(first.message.firstTokenAt).not.toBeNull();
    expect(retried.message).toMatchObject({
      status: 'failed',
      provider: 'anthropic',
      model: 'claude-outro',
      firstTokenAt: null,
    });
    expect(await store.getMessage(first.message.id)).toMatchObject({ model: 'claude-outro' });
    expect(await store.getConversation('c1')).toMatchObject({
      provider: 'anthropic',
      model: 'claude-outro',
    });
  });
});

describe('sendMessage com Anexos', () => {
  it('grava os Anexos e manda os bytes antes do texto', async () => {
    const { store, deps } = await baseDeps();
    const provider = new ScriptedProvider(successEvents());
    const files = [imageFile('i1', 3), textFile('t1', '# notas')];

    const result = await sendMessage({ ...deps, tools: null, provider }, ask({ attachments: files }));

    expect(result.message.status).toBe('complete');
    const [user] = await store.listMessages('c1');
    expect(user!.parts).toEqual([
      { type: 'file', attachment: files[0]!.attachment },
      { type: 'file', attachment: files[1]!.attachment },
      { type: 'text', text: 'Pergunta' },
    ]);
    expect(store.attachments.get('i1')).toEqual({ conversationId: 'c1', blob: files[0]!.blob });
    expect(provider.requests[0]!.messages[0]!.parts).toEqual([
      ...files.map(({ attachment, blob }) => ({ type: 'file', attachment, data: blob })),
      { type: 'text', text: 'Pergunta' },
    ]);
  });

  it('parar enquanto os Anexos são lidos fecha em interrupted sem chegar à rede', async () => {
    const reading = deferred();
    const release = deferred();
    class SlowStore extends MemoryStore {
      override async readAttachments(ids: string[]): Promise<Blob[]> {
        reading.resolve();
        await release.promise;
        return super.readAttachments(ids);
      }
    }
    const { deps } = await baseDeps(new SlowStore());
    const provider = new ScriptedProvider(successEvents());
    const controller = new AbortController();

    const run = await startSendMessage(
      { ...deps, tools: null, provider },
      ask({ attachments: [imageFile('i1')], signal: controller.signal }),
    );
    await reading.promise;
    controller.abort();
    release.resolve();

    const result = await run.result;
    expect(result.message.status).toBe('interrupted');
    expect(provider.requests).toEqual([]);
  });

  it('Anexo que sumiu do navegador falha a resposta com storage_failed', async () => {
    const { store, deps } = await baseDeps();
    const provider = new ScriptedProvider(successEvents());
    const first = await sendMessage({ ...deps, tools: null, provider }, ask({ attachments: [imageFile('i1')] }));
    store.attachments.delete('i1');

    const retried = await retryMessage(
      { ...deps, tools: null, provider },
      {
        conversationId: 'c1',
        messageId: first.message.id,
        model: testModel,
        effort: 'low',
        signal: new AbortController().signal,
      },
    );

    expect(retried.message.status).toBe('failed');
    expect(retried.message.error?.code).toBe('storage_failed');
    expect(provider.requests).toHaveLength(1);
  });
});
