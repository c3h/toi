import { describe, expect, it } from 'vitest';
import { conversationLock, HISTORY_LOCK } from '../src/app/locks';
import { recoverInterrupted } from '../src/app/recover-interrupted';
import { fixedClock, makeMessage, MemoryLocks, MemoryStore } from './helpers';

const now = 100_000;

const streaming = () =>
  makeMessage({
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    role: 'assistant',
    status: 'streaming',
  });

const storeWith = async (messages: ReturnType<typeof makeMessage>[]) => {
  const store = new MemoryStore();
  for (const message of messages) await store.putMessage(message);
  return store;
};

describe('recoverInterrupted', () => {
  it('converte em interrupted quando ninguém segura o lock da Conversa', async () => {
    const store = await storeWith([streaming()]);
    const locks = new MemoryLocks();

    const recovered = await recoverInterrupted({ store, clock: fixedClock(now), locks });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('interrupted');
    expect((await store.messages.get('m1'))?.status).toBe('interrupted');
  });

  it('não toca no Fluxo de outra aba enquanto ela segura o lock', async () => {
    const store = await storeWith([streaming()]);
    const locks = new MemoryLocks();
    const release = await locks.tryAcquire(conversationLock('c1'));

    const recovered = await recoverInterrupted({ store, clock: fixedClock(now), locks });

    expect(recovered).toEqual([]);
    expect((await store.messages.get('m1'))?.status).toBe('streaming');
    await release?.();
  });

  it('não grava enquanto outra aba apaga o histórico', async () => {
    const store = await storeWith([streaming()]);
    const locks = new MemoryLocks();
    const release = await locks.tryAcquire(HISTORY_LOCK, 'exclusive');

    const recovered = await recoverInterrupted({ store, clock: fixedClock(now), locks });

    expect(recovered).toEqual([]);
    expect((await store.messages.get('m1'))?.status).toBe('streaming');
    await release?.();
  });

  it('relê sob o lock e não reabre uma Mensagem que fechou depois da listagem', async () => {
    class ClosingStore extends MemoryStore {
      override async listStreamingMessages() {
        const listed = await super.listStreamingMessages();
        // O dono fecha o Fluxo entre a listagem e a aquisição do lock.
        await this.putMessage({ ...listed[0]!, status: 'complete' });
        return listed;
      }
    }

    const store = new ClosingStore();
    await store.putMessage(streaming());

    const recovered = await recoverInterrupted({
      store,
      clock: fixedClock(now),
      locks: new MemoryLocks(),
    });

    expect(recovered).toEqual([]);
    expect((await store.messages.get('m1'))?.status).toBe('complete');
  });
});
