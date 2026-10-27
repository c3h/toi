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
