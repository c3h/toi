import { describe, expect, it } from 'vitest';
import {
  elisionMarker,
  selectHistory,
  toChatRequest,
  type SelectedMessage,
} from '../src/app/build-request';
import type { AttachmentUpload } from '../src/domain/attachment';
import { attachmentsOf, type Message } from '../src/domain/message';
import type { Model } from '../src/domain/model';
import { filePart, imageFile, makeMessage, pdfFile, testModel, textFile } from './helpers';

const conversationId = 'c1';

const message = (
  id: string,
  seq: number,
  role: Message['role'],
  text: string,
  status: Message['status'] = 'complete',
): Message =>
  makeMessage({
    id,
    conversationId,
    seq,
    role,
    status,
    parts: text ? [{ type: 'text', text }] : [],
  });

const estimator = { estimate: (value: string) => value.length, estimateAttachment: () => 1 };

const text = (value: string) => ({ type: 'text' as const, text: value });

const model = (overrides: Partial<Model> = {}): Model => ({ ...testModel, ...overrides });

describe('selectHistory', () => {
  it('funde mensagens consecutivas do mesmo papel e preserva a ordem', () => {
    const request = selectHistory({
      messages: [
        message('1', 1, 'user', 'a'),
        message('2', 2, 'user', 'b'),
        message('3', 3, 'assistant', 'c'),
        message('4', 4, 'user', 'd'),
      ],
      model: model(),
      effort: 'low',
      estimator,
    });

    expect(request.messages).toEqual([
      { role: 'user', parts: [text('a'), text('b')] },
      { role: 'assistant', parts: [text('c')] },
      { role: 'user', parts: [text('d')] },
    ]);
  });

  it('descarta assistant vazio e assistant fora das pontas', () => {
    const request = selectHistory({
      messages: [
        message('0', 0, 'assistant', 'sobra'),
        message('1', 1, 'user', 'pergunta'),
        message('2', 2, 'assistant', ''),
        message('3', 3, 'assistant', 'final'),
      ],
      model: model(),
      effort: 'low',
      estimator,
    });

    expect(request.messages).toEqual([{ role: 'user', parts: [text('pergunta')] }]);
  });

  it('limita maxTokens ao teto do Modelo', () => {
    const high = selectHistory({
      messages: [message('1', 1, 'user', 'oi')],
      model: model({ maxTokens: 100_000 }),
      effort: 'low',
      estimator,
    });
    expect(high.maxTokens).toBe(8_192);

    const low = selectHistory({
      messages: [message('1', 1, 'user', 'oi')],
      model: model({ maxTokens: 4_096 }),
      effort: 'low',
      estimator,
    });
    expect(low.maxTokens).toBe(4_096);
  });

  it('trunca turnos do meio preservando o primeiro turno e o atual', () => {
    const { truncated, ...request } = selectHistory({
      messages: [
        message('1', 1, 'user', 'a'.repeat(10)),
        message('2', 2, 'assistant', 'b'.repeat(10)),
        message('3', 3, 'user', 'c'.repeat(10)),
        message('4', 4, 'assistant', 'd'.repeat(10)),
        message('5', 5, 'user', 'e'.repeat(10)),
      ],
      model: model({ maxInputTokens: 40 }),
      effort: 'low',
      estimator,
    });

    expect(truncated).toEqual({ turns: true, attachments: false });
    expect(request.messages).toEqual([
      { role: 'user', parts: [text('a'.repeat(10))] },
      { role: 'assistant', parts: [text('b'.repeat(10))] },
      { role: 'user', parts: [text('e'.repeat(10))] },
    ]);
  });

  it('envia só Partes de texto, aparadas, e não reenvia raciocínio', () => {
    const request = selectHistory({
      messages: [
        makeMessage({ id: '1', conversationId, seq: 1, role: 'user', parts: [text('  oi  ')] }),
        makeMessage({
          id: '2',
          conversationId,
          seq: 2,
          role: 'assistant',
          parts: [{ type: 'reasoning', text: 'pensando', signature: 'sig' }, text('resposta')],
        }),
        makeMessage({ id: '3', conversationId, seq: 3, role: 'user', parts: [text('mais')] }),
      ],
      model: model(),
      effort: 'low',
      estimator,
    });

    expect(request.messages).toEqual([
      { role: 'user', parts: [text('oi')] },
      { role: 'assistant', parts: [text('resposta')] },
      { role: 'user', parts: [text('mais')] },
    ]);
  });
});

/** Um turno: a Mensagem do user com os Anexos e uma resposta curta. */
const turn = (seq: number, files: AttachmentUpload[], text = `pergunta ${seq}`): Message[] => [
  makeMessage({
    id: `u${seq}`,
    conversationId,
    seq: seq * 2,
    role: 'user',
    parts: [...files.map(filePart), { type: 'text', text }],
  }),
  makeMessage({
    id: `a${seq}`,
    conversationId,
    seq: seq * 2 + 1,
    role: 'assistant',
    parts: [{ type: 'text', text: `resposta ${seq}` }],
  }),
];

/** O histórico termina numa Mensagem do user: tira a resposta do último turno. */
const history = (...turns: Message[][]): Message[] => turns.flat().slice(0, -1);

const fileNames = (messages: Array<Pick<Message, 'parts'>>) =>
  messages.flatMap(attachmentsOf).map(({ id }) => id);

const markers = (messages: SelectedMessage[]) =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === 'text' && part.text.startsWith('[Attachment') ? [part.text] : [],
    ),
  );

describe('selectHistory com Anexos', () => {
  it.each([
    {
      teto: 'páginas',
      turns: [turn(1, [pdfFile('p1', 60)]), turn(2, [pdfFile('p2', 60)])],
      elided: ['p1'],
    },
    {
      teto: 'blocos',
      turns: Array.from({ length: 11 }, (_, index) =>
        turn(
          index + 1,
          Array.from({ length: 10 }, (_, file) => imageFile(`i${index + 1}-${file}`)),
        ),
      ),
      elided: Array.from({ length: 10 }, (_, file) => `i1-${file}`),
    },
    {
      // 22 MB crus cabem; em base64 passam de 29 MB.
      teto: 'bytes em base64',
      turns: [1, 2].map((seq) => turn(seq, [pdfFile(`p${seq}`, 1, 11_000_000)])),
      elided: ['p1'],
    },
  ])('troca Anexos antigos por marcador quando passa do teto de $teto', ({ turns, elided }) => {
    const all = fileNames(turns.flat());

    const selected = selectHistory({
      messages: history(...turns),
      model: model(),
      effort: 'low',
      estimator,
    });

    expect(fileNames(selected.messages)).toEqual(all.filter((id) => !elided.includes(id)));
    expect(markers(selected.messages)).toHaveLength(elided.length);
    expect(selected.truncated).toEqual({ turns: false, attachments: true });
  });

  it('com 1 milhão de tokens de contexto cabem 600 páginas', () => {
    const selected = selectHistory({
      messages: history(turn(1, [pdfFile('p1', 60)]), turn(2, [pdfFile('p2', 60)])),
      model: model({ maxInputTokens: 1_000_000 }),
      effort: 'low',
      estimator,
    });

    expect(fileNames(selected.messages)).toEqual(['p1', 'p2']);
    expect(selected.truncated).toBeNull();
  });

  it('nunca tira Anexo do turno atual, mesmo com o histórico cheio', () => {
    const selected = selectHistory({
      messages: history(turn(1, [pdfFile('p1', 40)]), turn(2, [pdfFile('p2', 100)])),
      model: model(),
      effort: 'low',
      estimator,
    });

    expect(fileNames(selected.messages)).toEqual(['p2']);
  });

  it('tira um documento grande antes de cortar turnos de texto pelos tokens', () => {
    // O marcador custa ~120 tokens com este estimador; o documento, 250 de um orçamento de 240.
    const heavy = { estimate: (value: string) => value.length, estimateAttachment: () => 250 };

    const selected = selectHistory({
      messages: history(turn(1, [textFile('t1')]), turn(2, []), turn(3, [])),
      model: model({ maxInputTokens: 300 }),
      effort: 'low',
      estimator: heavy,
    });

    expect(fileNames(selected.messages)).toEqual([]);
    expect(selected.messages).toHaveLength(5);
    expect(selected.truncated).toEqual({ turns: false, attachments: true });
  });
});

describe('toChatRequest', () => {
  it('busca só os Anexos que ficaram e os entrega com os bytes', async () => {
    const files = [imageFile('i1', 3), pdfFile('p1', 1, 4), textFile('t1', '# notas')];
    const blobs = new Map(files.map(({ attachment, blob }) => [attachment.id, blob]));
    const read: string[][] = [];

    const request = await toChatRequest(
      selectHistory({
        messages: history(turn(1, [pdfFile('velho', 100)]), turn(2, files)),
        model: model(),
        effort: 'low',
        estimator,
      }),
      async (ids) => {
        read.push(ids);
        return ids.map((id) => blobs.get(id)!);
      },
    );

    expect(read).toEqual([['i1', 'p1', 't1']]);
    expect(request.messages.at(-1)!.parts).toEqual([
      ...files.map(({ attachment, blob }) => ({ type: 'file', attachment, data: blob })),
      text('pergunta 2'),
    ]);
    expect(request.messages[0]!.parts).toEqual([
      text(elisionMarker('velho.pdf')),
      text('pergunta 1'),
    ]);
  });
});
