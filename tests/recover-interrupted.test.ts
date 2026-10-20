import { describe, expect, it } from 'vitest';
import { recoverInterrupted } from '../src/app/recover-interrupted';
import { makeMessage, MemoryStore } from './helpers';

const storeWith = async (messages: ReturnType<typeof makeMessage>[]) => {
  const store = new MemoryStore();
  for (const message of messages) await store.putMessage(message);
  return store;
};

describe('recoverInterrupted', () => {
  it('converte em interrupted quando o lease venceu', async () => {
    const now = 100_000;
    const store = await storeWith([
      makeMessage({
        id: 'm1',
        conversationId: 'c1',
        seq: 1,
        role: 'assistant',
        status: 'streaming',
        stream: { owner: 'tab-a', heartbeatAt: now - 20_000 },
      }),
    ]);

    const recovered = await recoverInterrupted(store, now);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('interrupted');
    expect(recovered[0]?.stream).toBeNull();
    expect((await store.messages.get('m1'))?.status).toBe('interrupted');
  });

  it('não toca no Fluxo de outra aba enquanto o lease está vivo', async () => {
    const now = 100_000;
    const store = await storeWith([
      makeMessage({
        id: 'm1',
        conversationId: 'c1',
        seq: 1,
        role: 'assistant',
        status: 'streaming',
        stream: { owner: 'tab-a', heartbeatAt: now - 1_000 },
      }),
    ]);

    const recovered = await recoverInterrupted(store, now);

    expect(recovered).toEqual([]);
    expect((await store.messages.get('m1'))?.status).toBe('streaming');
  });

  it('converte em interrupted quando não há lease', async () => {
    const now = 100_000;
    const store = await storeWith([
      makeMessage({
        id: 'm1',
        conversationId: 'c1',
        seq: 1,
        role: 'assistant',
        status: 'streaming',
      }),
    ]);

    const recovered = await recoverInterrupted(store, now);

    expect(recovered[0]?.status).toBe('interrupted');
  });
});
