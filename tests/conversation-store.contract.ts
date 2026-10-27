import { describe, expect, it } from 'vitest';
import type { ConversationStore } from '../src/ports/conversation-store';
import {
  filePart,
  imageFile,
  makeConversation,
  makeMessage,
  pdfFile,
  textFile,
} from './helpers';

export interface StoreHarness {
  store: ConversationStore;
  cleanup(): Promise<void>;
}

export const describeConversationStore = (
  name: string,
  open: () => Promise<StoreHarness>,
): void => {
  describe(name, () => {
    it('updateConversation aplica a mudança sobre o que está gravado e não recria apagada', async () => {
      const { store, cleanup } = await open();

      try {
        await store.putConversation(makeConversation('c1', { title: 'Antes', updatedAt: 1 }));
        await store.putConversation(makeConversation('c1', { title: 'Outra aba', updatedAt: 1 }));

        const updated = await store.updateConversation('c1', (current) => ({
          ...current,
          updatedAt: 9,
        }));

        expect(updated).toMatchObject({ title: 'Outra aba', updatedAt: 9 });
        expect(await store.getConversation('c1')).toEqual(updated);

        await store.deleteConversation('c1');
        expect(await store.updateConversation('c1', (current) => current)).toBeNull();
        expect(await store.getConversation('c1')).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it('startTurn grava Conversa, Mensagens e Anexos juntos e não recria apagada', async () => {
      const { store, cleanup } = await open();

      try {
        const file = textFile('a1', 'olá');
        const other = textFile('a0', 'outro');
        const user = makeMessage({
          id: 'm1',
          conversationId: 'c1',
          seq: 1,
          role: 'user',
          parts: [filePart(file)],
        });
        const assistant = makeMessage({
          id: 'm2',
          conversationId: 'c1',
          seq: 2,
          role: 'assistant',
          status: 'streaming',
        });
        await store.putConversation(makeConversation('c1', { title: 'Antes' }));

        const updated = await store.startTurn({
          conversationId: 'c1',
          change: (current) => ({ ...current, title: 'Depois' }),
          messages: [user, assistant],
          attachments: [file, other],
        });

        expect(updated).toMatchObject({ title: 'Depois' });
        expect(await store.getConversation('c1')).toEqual(updated);
        expect(await store.listMessages('c1')).toEqual([user, assistant]);
        // Na ordem pedida: `toChatRequest` casa cada id com o seu Blob pela posição.
        const blobs = await store.readAttachments(['a1', 'a0']);
        expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual(['olá', 'outro']);

        expect(
          await store.startTurn({
            conversationId: 'apagada',
            change: (current) => current,
            messages: [makeMessage({ id: 'm3', conversationId: 'apagada', seq: 1, role: 'user' })],
            attachments: [textFile('a2')],
          }),
        ).toBeNull();
        expect(await store.getConversation('apagada')).toBeNull();
        expect(await store.listMessages('apagada')).toEqual([]);
        await expect(store.readAttachments(['a2'])).rejects.toMatchObject({
          code: 'storage_failed',
        });
      } finally {
        await cleanup();
      }
    });

    it('snapshot lê Conversas, Mensagens por seq e os bytes dos Anexos', async () => {
      const { store, cleanup } = await open();

      try {
        const file = textFile('a1', 'bytes');
        await store.putConversation(makeConversation('velha', { updatedAt: 1 }));
        await store.putConversation(makeConversation('nova', { updatedAt: 2 }));
        await store.putMessage(
          makeMessage({ id: 'm2', conversationId: 'velha', seq: 2, role: 'assistant' }),
        );
        await store.startTurn({
          conversationId: 'velha',
          change: (current) => current,
          messages: [
            makeMessage({
              id: 'm1',
              conversationId: 'velha',
              seq: 1,
              role: 'user',
              parts: [filePart(file)],
            }),
          ],
          attachments: [file],
        });

        const snapshot = await store.snapshot();

        expect(snapshot.conversations.map(({ conversation }) => conversation.id)).toEqual([
          'nova',
          'velha',
        ]);
        expect(snapshot.conversations[0]!.messages).toEqual([]);
        expect(snapshot.conversations[1]!.messages.map((message) => message.id)).toEqual([
          'm1',
          'm2',
        ]);
        expect(await snapshot.attachments.get('a1')!.text()).toBe('bytes');
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
            { type: 'redacted_reasoning', data: 'cifrado' },
            {
              type: 'tool_call',
              callId: 't1',
              tool: 'web_fetch',
              input: { urls: ['https://a.com/'], nested: { n: 1, ok: true, none: null } },
            },
            {
              type: 'tool_result',
              callId: 't1',
              content: 'texto lido',
              sources: [{ title: 'A', url: 'https://a.com/' }],
              failures: [{ url: 'https://b.com/', code: 'blocked' }],
              error: null,
            },
            {
              type: 'tool_result',
              callId: 't2',
              content: 'Error: x',
              sources: [],
              failures: [],
              error: { code: 'tool_rate_limited', message: 'espere', detail: null, retryAfterSeconds: 9 },
            },
            { type: 'text', text: 'resposta' },
          ],
          status: 'failed',
          createdAt: 10,
          completedAt: 20,
          firstTokenAt: 12,
          model: 'claude-test',
          effort: 'xhigh',
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheCreationInputTokens: 3,
            cacheReadInputTokens: 4,
          },
          stopReason: 'max_tokens',
          error: { code: 'overloaded', message: 'cheio', detail: 'x', retryAfterSeconds: 5 },
        });

        const withFiles = makeMessage({
          id: 'm2',
          conversationId: 'c1',
          seq: 8,
          role: 'user',
          parts: [
            filePart(imageFile('a1')),
            filePart(pdfFile('a2', null)),
            filePart(pdfFile('a3', 12)),
            filePart(textFile('a4')),
            { type: 'text', text: 'veja' },
          ],
        });

        await store.putMessage(full);
        await store.putMessage(withFiles);

        expect(await store.listMessages('c1')).toEqual([full, withFiles]);
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

    it('apaga a Conversa, as Mensagens e os Anexos dela em cascata', async () => {
      const { store, cleanup } = await open();

      try {
        await store.putConversation(makeConversation('c1', { updatedAt: 10 }));
        await store.putConversation(makeConversation('c2', { updatedAt: 20 }));
        for (const [conversationId, id] of [['c1', 'm1'], ['c2', 'm2']] as const) {
          await store.startTurn({
            conversationId,
            change: (current) => current,
            messages: [makeMessage({ id, conversationId, seq: 1, role: 'user' })],
            attachments: [textFile(`${id}-a`)],
          });
        }

        await store.putMessage(
          makeMessage({ id: 'm1b', conversationId: 'c1', seq: 2, role: 'assistant' }),
        );

        await store.deleteConversation('c1');

        expect(await store.getConversation('c1')).toBeNull();
        expect(await store.getMessage('m1b')).toBeNull();
        expect(await store.listMessages('c1')).toEqual([]);
        await expect(store.readAttachments(['m1-a'])).rejects.toMatchObject({
          code: 'storage_failed',
        });
        expect(await store.getConversation('c2')).not.toBeNull();
        expect(await store.listMessages('c2')).toHaveLength(1);
        expect(await store.readAttachments(['m2-a'])).toHaveLength(1);

        await store.clearConversations();
        await expect(store.readAttachments(['m2-a'])).rejects.toMatchObject({
          code: 'storage_failed',
        });
      } finally {
        await cleanup();
      }
    });
  });
};
