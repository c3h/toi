import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nameConversation,
  TITLE_TIMEOUT_MS,
  type FirstExchange,
} from '../src/app/name-conversation';
import type { StreamEvent } from '../src/domain/stream';
import {
  makeConversation,
  makeModel,
  MemoryStore,
  ScriptedProvider,
  untilAborted,
  usage,
} from './helpers';

const haiku = makeModel('claude-haiku-5-5');

const exchange: FirstExchange = {
  conversationId: 'c1',
  question: 'como faço pão de fermentação natural?',
  answer: 'Você vai precisar de um levain ativo…',
};

/** Resposta do Modelo do Título que termina normalmente. */
const titled = (text: string, stopReason: 'end_turn' | 'max_tokens' = 'end_turn'): StreamEvent[] => [
  { type: 'started', model: haiku.id, usage: usage(10, 0) },
  { type: 'part_started', index: 0, part: { type: 'text' } },
  { type: 'delta', index: 0, part: 'text', text },
  { type: 'part_finished', index: 0 },
  { type: 'usage', usage: usage(10, 5), stopReason },
  { type: 'finished' },
];

const setup = async (overrides: Parameters<typeof makeConversation>[1] = {}) => {
  const store = new MemoryStore();
  await store.putConversation(makeConversation('c1', { title: 'como faço pão…', ...overrides }));
  return store;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('nameConversation', () => {
  it('grava o Título sobre o derivado, sem tocar updatedAt', async () => {
    const store = await setup({ updatedAt: 5 });
    const provider = new ScriptedProvider(titled('"Pão de fermentação natural."'));

    const outcome = await nameConversation(store, provider, haiku, exchange, new AbortController().signal);

    expect(outcome).toBe('named');
    expect(await store.getConversation('c1')).toMatchObject({
      title: 'Pão de fermentação natural',
      titleSource: 'generated',
      updatedAt: 5,
    });
  });

  it('não passa por cima do Título que a pessoa renomeou', async () => {
    const store = await setup({ title: 'Meu pão', titleSource: 'manual' });
    const provider = new ScriptedProvider(titled('Pão de fermentação natural'));

    const outcome = await nameConversation(store, provider, haiku, exchange, new AbortController().signal);

    expect(outcome).toBe('kept');
    expect(await store.getConversation('c1')).toMatchObject({ title: 'Meu pão', titleSource: 'manual' });
  });

  it('resposta cortada ou vazia deixa o derivado', async () => {
    const store = await setup();

    for (const events of [titled('Pão de ferm', 'max_tokens'), titled('  ""  ')]) {
      const outcome = await nameConversation(
        store,
        new ScriptedProvider(events),
        haiku,
        exchange,
        new AbortController().signal,
      );
      expect(outcome).toBe('kept');
    }
    expect(await store.getConversation('c1')).toMatchObject({ titleSource: 'derived' });
  });

  it('falha do Provedor deixa o derivado sem lançar', async () => {
    const store = await setup();
    const provider = new ScriptedProvider(async function* () {
      yield* [];
      throw new Error('fora do ar');
    });

    expect(await nameConversation(store, provider, haiku, exchange, new AbortController().signal)).toBe(
      'failed',
    );
    expect(await store.getConversation('c1')).toMatchObject({ titleSource: 'derived' });
  });

  it('Conversa apagada no meio não é recriada', async () => {
    const store = await setup();
    const provider = new ScriptedProvider(async function* () {
      await store.deleteConversation('c1');
      yield* titled('Pão');
    });

    expect(await nameConversation(store, provider, haiku, exchange, new AbortController().signal)).toBe(
      'kept',
    );
    expect(await store.getConversation('c1')).toBeNull();
  });

  it('cancelar ou estourar o prazo deixa o derivado', async () => {
    vi.useFakeTimers();
    const store = await setup();
    const hanging = () =>
      new ScriptedProvider(async function* (signal) {
        yield* [];
        await untilAborted(signal);
      });

    const controller = new AbortController();
    const stopped = nameConversation(store, hanging(), haiku, exchange, controller.signal);
    controller.abort();
    expect(await stopped).toBe('aborted');

    const late = nameConversation(store, hanging(), haiku, exchange, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS);
    expect(await late).toBe('failed');
    expect(await store.getConversation('c1')).toMatchObject({ titleSource: 'derived' });
  });
});
