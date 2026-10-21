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
  MemoryStore,
  ScriptedProvider,
  testModel,
  usage,
} from './helpers';

const successEvents = (): StreamEvent[] => [
  { type: 'started', model: testModel.id, usage: usage(10, 0) },
  { type: 'part_started', index: 0, part: 'text' },
  { type: 'delta', index: 0, part: 'text', text: 'Olá' },
  { type: 'delta', index: 0, part: 'text', text: ', mundo' },
  { type: 'part_finished', index: 0 },
  { type: 'usage', usage: usage(10, 5), stopReason: 'end_turn' },
  { type: 'finished' },
];

const sendMessage = async (deps: RunDeps, options: SendOptions): Promise<RunResult> =>
  (await startSendMessage(deps, options)).result;

const retryMessage = async (deps: RunDeps, options: RetryOptions): Promise<RunResult> =>
  (await startRetryMessage(deps, options)).result;

describe('sendMessage', () => {
  it('persiste user e assistant, faz streaming e fecha em complete', async () => {
    const { store, deps } = await baseDeps();
    const provider = new ScriptedProvider(successEvents());

    const result = await sendMessage(
      { ...deps, provider },
      { conversationId: 'c1', text: 'Pergunta', model: testModel, signal: new AbortController().signal },
    );

    expect(result.message.status).toBe('complete');
    expect(textOf(result.message)).toBe('Olá, mundo');
    expect(result.message.usage?.outputTokens).toBe(5);
    expect(result.message.stopReason).toBe('end_turn');
    expect(result.truncated).toBe(false);
    expect(result.persistError).toBeNull();

    const messages = await store.listMessages('c1');
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages.map((message) => message.seq)).toEqual([1, 2]);

    const conversation = await store.getConversation('c1');
    expect(conversation?.title).toBe('Pergunta');

    expect(provider.requests[0]).toEqual({
      model: testModel.id,
      maxTokens: 8_192,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Pergunta' }] }],
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
      yield { type: 'part_started', index: 0, part: 'text' };
      yield { type: 'delta', index: 0, part: 'text', text: 'parcial' };

      if (controller.signal.aborted) throw abortError();
      await new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    });

    const promise = sendMessage(
      {
        ...deps,
        provider,
        onUpdate: (message) => {
          if (textOf(message) === 'parcial') signalFirstDelta();
        },
      },
      { conversationId: 'c1', text: 'Pergunta', model: testModel, signal: controller.signal },
    );

    await firstDelta;
    controller.abort();

    const result = await promise;

    expect(result.message.status).toBe('interrupted');
    expect(textOf(result.message)).toBe('parcial');
    expect(result.message.error).toBeNull();
    expect(result.message.stream).toBeNull();
  });

  it('marca failed com AppError tipado', async () => {
    const { deps } = await baseDeps();

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
      throw new AppError('overloaded', 'O Modelo está sobrecarregado.');
    });

    const result = await sendMessage(
      { ...deps, provider },
      { conversationId: 'c1', text: 'Pergunta', model: testModel, signal: new AbortController().signal },
    );

    expect(result.message.status).toBe('failed');
    expect(result.message.error?.code).toBe('overloaded');
    expect(result.message.stream).toBeNull();
  });

  it('não reabre uma Mensagem finalizada quando o corpo falha depois de finished', async () => {
    const { deps } = await baseDeps();

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield* successEvents();
      throw abortError();
    });

    const result = await sendMessage(
      { ...deps, provider },
      { conversationId: 'c1', text: 'Pergunta', model: testModel, signal: new AbortController().signal },
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
      { ...deps, provider },
      { conversationId: 'c1', text: 'Pergunta', model: testModel, signal: new AbortController().signal },
    );

    expect(result.message.status).toBe('complete');
    expect(textOf(result.message)).toBe('ok');
    expect(result.persistError?.code).toBe('storage_failed');
  });

  it('renova o heartbeat do lease a cada Evento do Fluxo', async () => {
    const { deps, clock } = await baseDeps();
    const heartbeats: number[] = [];

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
      yield { type: 'delta', index: 0, part: 'text', text: 'a' };
      clock.set(60_000);
      yield { type: 'delta', index: 0, part: 'text', text: 'b' };
      yield { type: 'finished' };
    });

    await sendMessage(
      {
        ...deps,
        provider,
        onUpdate: (message) => {
          if (message.status === 'streaming' && message.stream) {
            heartbeats.push(message.stream.heartbeatAt);
          }
        },
      },
      { conversationId: 'c1', text: 'Pergunta', model: testModel, signal: new AbortController().signal },
    );

    expect(heartbeats).toContain(50_000);
    expect(heartbeats).toContain(60_000);
    expect(heartbeats[heartbeats.length - 1]).toBe(60_000);
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
      { ...deps, provider },
      { conversationId: 'c1', text: 'Pergunta', model: testModel, signal: new AbortController().signal },
    );

    failing = false;

    const retried = await retryMessage(
      { ...deps, provider },
      {
        conversationId: 'c1',
        messageId: first.message.id,
        model: testModel,
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
