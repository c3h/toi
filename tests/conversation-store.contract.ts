import { describe, expect, it } from 'vitest';
import type { ConversationStore } from '../src/ports/conversation-store';
import { makeConversation, makeMessage } from './helpers';

export interface StoreHarness {
  store: ConversationStore;
  cleanup(): Promise<void>;
}

export const describeConversationStore = (
  name: string,
  open: () => Promise<StoreHarness>,
): void => {
  describe(name, () => {
    it('lê, grava e substitui Conversas pelo id', async () => {
      const { store, cleanup } = await open();

      try {
        expect(await store.getConversation('c1')).toBeNull();

        await store.putConversation(makeConversation('c1', { updatedAt: 10 }));
        expect(await store.getConversation('c1')).toEqual(makeConversation('c1', { updatedAt: 10 }));

        await store.putConversation(makeConversation('c1', { updatedAt: 20 }));
        expect((await store.getConversation('c1'))?.updatedAt).toBe(20);
      } finally {
        await cleanup();
      }
    });

    it('lista Conversas por updatedAt decrescente', async () => {
      const { store, cleanup } = await open();

      try {
        await store.putConversation(makeConversation('velha', { updatedAt: 10 }));
        await store.putConversation(makeConversation('nova', { updatedAt: 30 }));
        await store.putConversation(makeConversation('meio', { updatedAt: 20 }));

        expect((await store.listConversations()).map((item) => item.id)).toEqual([
          'nova',
          'meio',
          'velha',
        ]);
      } finally {
        await cleanup();
      }
    });

    it('lista Mensagens por seq e por Conversa', async () => {
      const { store, cleanup } = await open();

      try {
        await store.putMessage(
          makeMessage({ id: 'm2', conversationId: 'c1', seq: 2, role: 'assistant' }),
        );
        await store.putMessage(
          makeMessage({ id: 'm1', conversationId: 'c1', seq: 1, role: 'user' }),
        );
        await store.putMessage(
          makeMessage({ id: 'outra', conversationId: 'c2', seq: 1, role: 'user' }),
        );

        expect((await store.listMessages('c1')).map((message) => message.id)).toEqual([
          'm1',
          'm2',
        ]);
        expect((await store.listMessages('c2')).map((message) => message.id)).toEqual(['outra']);
        expect(await store.listMessages('sem-mensagens')).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('lê uma Mensagem pelo id', async () => {
      const { store, cleanup } = await open();

      try {
        const message = makeMessage({ id: 'm1', conversationId: 'c1', seq: 1, role: 'user' });
        await store.putMessage(message);

        expect(await store.getMessage('m1')).toEqual(message);
        expect(await store.getMessage('ausente')).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it('substitui a Mensagem pelo id', async () => {
      const { store, cleanup } = await open();

      try {
        await store.putMessage(
          makeMessage({
            id: 'm1',
            conversationId: 'c1',
            seq: 1,
            role: 'assistant',
            status: 'complete',
            parts: [{ type: 'text', text: 'antes' }],
          }),
        );
        await store.putMessage(
          makeMessage({
            id: 'm1',
            conversationId: 'c1',
            seq: 1,
            role: 'assistant',
            status: 'complete',
            parts: [{ type: 'text', text: 'depois' }],
          }),
        );

        const messages = await store.listMessages('c1');
        expect(messages).toHaveLength(1);
        expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'depois' }]);
      } finally {
        await cleanup();
      }
    });

    it('preserva todos os campos da Mensagem na ida e na volta', async () => {
      const { store, cleanup } = await open();

      try {
        const full = makeMessage({
          id: 'm1',
          conversationId: 'c1',
          seq: 7,
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'pensando', signature: 'sig' },
            { type: 'text', text: 'resposta' },
          ],
          status: 'failed',
          createdAt: 10,
          completedAt: 20,
          model: 'claude-test',
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheCreationInputTokens: 3,
            cacheReadInputTokens: 4,
          },
          stopReason: 'max_tokens',
          error: { code: 'overloaded', message: 'cheio', detail: 'x', retryAfterSeconds: 5 },
          stream: { owner: 'tab-a', heartbeatAt: 15 },
        });

        await store.putMessage(full);

        expect(await store.listMessages('c1')).toEqual([full]);
      } finally {
        await cleanup();
      }
    });

    it('lista só Mensagens em Fluxo', async () => {
      const { store, cleanup } = await open();

      try {
        await store.putMessage(
          makeMessage({ id: 'm1', conversationId: 'c1', seq: 1, role: 'assistant' }),
        );
        await store.putMessage(
          makeMessage({
            id: 'm2',
            conversationId: 'c2',
            seq: 2,
            role: 'assistant',
            status: 'streaming',
          }),
        );

        expect((await store.listStreamingMessages()).map((message) => message.id)).toEqual(['m2']);
      } finally {
        await cleanup();
      }
    });

    it('apaga a Conversa e as Mensagens dela em cascata', async () => {
      const { store, cleanup } = await open();

      try {
        await store.putConversation(makeConversation('c1', { updatedAt: 10 }));
        await store.putConversation(makeConversation('c2', { updatedAt: 20 }));
        await store.putMessage(
          makeMessage({ id: 'm1', conversationId: 'c1', seq: 1, role: 'user' }),
        );
        await store.putMessage(
          makeMessage({ id: 'm2', conversationId: 'c2', seq: 1, role: 'user' }),
        );

        await store.deleteConversation('c1');

        expect(await store.getConversation('c1')).toBeNull();
        expect(await store.listMessages('c1')).toEqual([]);
        expect(await store.getConversation('c2')).not.toBeNull();
        expect(await store.listMessages('c2')).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });

    it('clearConversations limpa Conversas e Mensagens', async () => {
      const { store, cleanup } = await open();

      try {
        await store.putConversation(makeConversation('c1', { updatedAt: 10 }));
        await store.putMessage(
          makeMessage({ id: 'm1', conversationId: 'c1', seq: 1, role: 'user' }),
        );

        await store.clearConversations();

        expect(await store.listConversations()).toEqual([]);
        expect(await store.listMessages('c1')).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });
};
