import { describe, expect, it } from 'vitest';
import { exportHistory } from '../src/app/export';
import { fixedClock, makeConversation, makeMessage, MemoryStore } from './helpers';

describe('exportHistory', () => {
  it('exporta Fluxo em voo como interrupted', async () => {
    const store = new MemoryStore();
    await store.putConversation(makeConversation('c1'));
    await store.putMessage(
      makeMessage({
        id: 'm1',
        conversationId: 'c1',
        seq: 1,
        role: 'assistant',
        status: 'streaming',
        parts: [{ type: 'text', text: 'parcial' }],
        firstTokenAt: 1_200,
        effort: 'max',
      }),
    );

    const exported = await exportHistory({ store, clock: fixedClock(5) });
    const message = exported.conversations[0]?.messages[0];

    expect(exported.conversations[0]).toMatchObject({ provider: 'anthropic', effort: 'low' });
    expect(message?.provider).toBe('anthropic');
    expect(message?.effort).toBe('max');
    expect(message?.firstTokenAt).toBe(1_200);
    expect(message?.status).toBe('interrupted');
    expect(message?.parts).toEqual([{ type: 'text', text: 'parcial' }]);
  });

  it('ordena Conversas como o histórico e Mensagens por seq', async () => {
    const store = new MemoryStore();
    await store.putConversation(makeConversation('velha', { updatedAt: 1 }));
    await store.putConversation(makeConversation('nova', { updatedAt: 2 }));
    await store.putMessage(makeMessage({ id: 'b', conversationId: 'nova', seq: 2, role: 'assistant' }));
    await store.putMessage(makeMessage({ id: 'a', conversationId: 'nova', seq: 1, role: 'user' }));

    const exported = await exportHistory({ store, clock: fixedClock(5) });

    expect(exported.conversations.map((conversation) => conversation.id)).toEqual(['nova', 'velha']);
    expect(exported.conversations[0]?.messages.map((message) => message.id)).toEqual(['a', 'b']);
  });
});
