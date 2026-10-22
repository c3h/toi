import { describe, expect, it } from 'vitest';
import { exportHistory, type HistoryExport } from '../src/app/export';
import {
  filePart,
  fixedClock,
  imageFile,
  makeConversation,
  makeMessage,
  MemoryStore,
  textFile,
} from './helpers';

const read = async (store: MemoryStore): Promise<HistoryExport> =>
  JSON.parse(await (await exportHistory({ store, clock: fixedClock(5) })).text()) as HistoryExport;

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

    const exported = await read(store);
    const message = exported.conversations[0]?.messages[0];

    expect(exported.conversations[0]).toMatchObject({ provider: 'anthropic', effort: 'low' });
    expect(message?.provider).toBe('anthropic');
    expect(message?.effort).toBe('max');
    expect(message?.firstTokenAt).toBe(1_200);
    expect(message?.status).toBe('interrupted');
    expect(message?.parts).toEqual([{ type: 'text', text: 'parcial' }]);
  });

  it('leva os bytes de cada Anexo em base64', async () => {
    const store = new MemoryStore();
    const notes = textFile('t1', 'olá');
    const image = imageFile('i1', 2);
    await store.putConversation(makeConversation('c1'));
    await store.startTurn({
      conversationId: 'c1',
      change: (current) => current,
      messages: [
        makeMessage({
          id: 'm1',
          conversationId: 'c1',
          seq: 1,
          role: 'user',
          parts: [filePart(image), filePart(notes), { type: 'text', text: 'veja' }],
        }),
        makeMessage({ id: 'm2', conversationId: 'c1', seq: 2, role: 'assistant' }),
      ],
      attachments: [image, notes],
    });

    const exported = await read(store);

    expect(exported.conversations[0]!.messages[0]!.parts).toEqual([
      { type: 'file', attachment: image.attachment, data: 'AAA=' },
      { type: 'file', attachment: notes.attachment, data: 'b2zDoQ==' },
      { type: 'text', text: 'veja' },
    ]);
  });
});
