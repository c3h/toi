import { describe, expect, it } from 'vitest';
import { MemoryLocks } from '../src/adapters/locks/memory';
import { conversationLock, HISTORY_LOCK } from '../src/app/locks';
import { recoverInterrupted } from '../src/app/recover-interrupted';
import type { StreamLease } from '../src/domain/message';
import { fixedClock, makeMessage, MemoryStore } from './helpers';

const now = 100_000;

const streaming = (stream: StreamLease | null = null) =>
  makeMessage({
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    role: 'assistant',
    status: 'streaming',
    stream,
  });

const storeWith = async (messages: ReturnType<typeof makeMessage>[]) => {
  const store = new MemoryStore();
  for (const message of messages) await store.putMessage(message);
  return store;
};

describe('recoverInterrupted com Web Locks', () => {
  it('converte em interrupted quando ninguém segura o lock da Conversa', async () => {
    // Lease recente: com locks, o heartbeat não decide nada.
    const store = await storeWith([streaming({ owner: 'tab-a', heartbeatAt: now })]);
    const locks = new MemoryLocks({ crossTab: true });

    const recovered = await recoverInterrupted({ store, clock: fixedClock(now), locks });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('interrupted');
    expect(recovered[0]?.stream).toBeNull();
    expect((await store.messages.get('m1'))?.status).toBe('interrupted');
  });

  it('não toca no Fluxo de outra aba enquanto ela segura o lock', async () => {
    // Lease vencido: o lock vivo prevalece.
    const store = await storeWith([streaming({ owner: 'tab-a', heartbeatAt: now - 60_000 })]);
    const locks = new MemoryLocks({ crossTab: true });
    const release = await locks.tryAcquire(conversationLock('c1'));

    const recovered = await recoverInterrupted({ store, clock: fixedClock(now), locks });

    expect(recovered).toEqual([]);
    expect((await store.messages.get('m1'))?.status).toBe('streaming');
    await release?.();
  });

  it('não grava enquanto outra aba apaga o histórico', async () => {
    const store = await storeWith([streaming({ owner: 'tab-a', heartbeatAt: now })]);
    const locks = new MemoryLocks({ crossTab: true });
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
        await this.putMessage({ ...listed[0]!, status: 'complete', stream: null });
        return listed;
      }
    }

    const store = new ClosingStore();
    await store.putMessage(streaming());

    const recovered = await recoverInterrupted({
      store,
      clock: fixedClock(now),
      locks: new MemoryLocks({ crossTab: true }),
    });

    expect(recovered).toEqual([]);
    expect((await store.messages.get('m1'))?.status).toBe('complete');
  });
});

describe('recoverInterrupted sem Web Locks', () => {
  const locks = () => new MemoryLocks({ crossTab: false });

  it('converte em interrupted quando o lease venceu', async () => {
    const store = await storeWith([streaming({ owner: 'tab-a', heartbeatAt: now - 20_000 })]);

    const recovered = await recoverInterrupted({ store, clock: fixedClock(now), locks: locks() });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('interrupted');
    expect(recovered[0]?.stream).toBeNull();
    expect((await store.messages.get('m1'))?.status).toBe('interrupted');
  });

  it('não toca no Fluxo de outra aba enquanto o lease está vivo', async () => {
    const store = await storeWith([streaming({ owner: 'tab-a', heartbeatAt: now - 1_000 })]);

    const recovered = await recoverInterrupted({ store, clock: fixedClock(now), locks: locks() });

    expect(recovered).toEqual([]);
    expect((await store.messages.get('m1'))?.status).toBe('streaming');
  });

  it('converte em interrupted quando não há lease', async () => {
    const store = await storeWith([streaming()]);

    const recovered = await recoverInterrupted({ store, clock: fixedClock(now), locks: locks() });

    expect(recovered[0]?.status).toBe('interrupted');
  });
});
