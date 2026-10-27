import { describe, expect, it } from 'vitest';
import { nameConversation } from '../src/app/name-conversation';
import { makeConversation, MemoryStore, replyEvents, ScriptedProvider, testModel } from './helpers';

describe('nameConversation', () => {
  it('não passa por cima do Título que a pessoa renomeou', async () => {
    const store = new MemoryStore();
    await store.putConversation(makeConversation('c1', { title: 'Meu pão', titleSource: 'manual' }));

    const outcome = await nameConversation(
      store,
      new ScriptedProvider(replyEvents('Pão de fermentação natural')),
      testModel,
      { conversationId: 'c1', question: 'como faço pão?', answer: 'Você vai precisar de levain.' },
      new AbortController().signal,
    );

    expect(outcome).toBe('kept');
    expect(await store.getConversation('c1')).toMatchObject({ title: 'Meu pão', titleSource: 'manual' });
  });
});
