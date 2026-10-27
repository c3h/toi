import { describe, expect, it } from 'vitest';
import {
  selectHistory,
  toChatRequest,
  type SelectedMessage,
  type SelectedPart,
  type SelectHistoryInput,
} from '../src/app/build-request';
import type { AttachmentUpload } from '../src/domain/attachment';
import type { Message, Part } from '../src/domain/message';
import type { Model } from '../src/domain/model';
import { filePart, imageFile, makeMessage, pdfFile, testModel } from './helpers';

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

const select = (input: Pick<SelectHistoryInput, 'messages'> & Partial<SelectHistoryInput>) =>
  selectHistory({
    model: model(),
    effort: 'low',
    estimator,
    toolSpace: null,
    instructions: null,
    ...input,
  });

describe('selectHistory', () => {
  it('funde mensagens consecutivas do mesmo papel e preserva a ordem', () => {
    const request = select({
      messages: [
        message('1', 1, 'user', 'a'),
        message('2', 2, 'user', 'b'),
        message('3', 3, 'assistant', 'c'),
        message('4', 4, 'user', 'd'),
      ],
    });

    expect(request.messages).toEqual([
      { role: 'user', parts: [text('a'), text('b')] },
      { role: 'assistant', parts: [text('c')] },
      { role: 'user', parts: [text('d')] },
    ]);
  });

  it('descarta assistant vazio e assistant fora das pontas', () => {
    const request = select({
      messages: [
        message('0', 0, 'assistant', 'sobra'),
        message('1', 1, 'user', 'pergunta'),
        message('2', 2, 'assistant', ''),
        message('3', 3, 'assistant', 'final'),
      ],
    });

    expect(request.messages).toEqual([{ role: 'user', parts: [text('pergunta')] }]);
  });

  it('trunca turnos do meio preservando o primeiro turno e o atual', () => {
    const { truncated, ...request } = select({
      messages: [
        message('1', 1, 'user', 'a'.repeat(10)),
        message('2', 2, 'assistant', 'b'.repeat(10)),
        message('3', 3, 'user', 'c'.repeat(10)),
        message('4', 4, 'assistant', 'd'.repeat(10)),
        message('5', 5, 'user', 'e'.repeat(10)),
      ],
      model: model({ maxInputTokens: 40 }),
    });

    expect(truncated).toEqual({ turns: true, attachments: false, results: false });
    expect(request.messages).toEqual([
      { role: 'user', parts: [text('a'.repeat(10))] },
      { role: 'assistant', parts: [text('b'.repeat(10))] },
      { role: 'user', parts: [text('e'.repeat(10))] },
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

const fileNames = (messages: Array<{ parts: Array<Part | SelectedPart> }>) =>
  messages.flatMap(({ parts }) =>
    parts.flatMap((part) => (part.type === 'file' ? [part.attachment.id] : [])),
  );

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

    const selected = select({
      messages: history(...turns),
    });

    expect(fileNames(selected.messages)).toEqual(all.filter((id) => !elided.includes(id)));
    expect(markers(selected.messages)).toHaveLength(elided.length);
    expect(selected.truncated).toEqual({ turns: false, attachments: true, results: false });
  });
});

const call = (callId: string, query = 'cobre'): Part => ({
  type: 'tool_call',
  callId,
  tool: 'web_search',
  input: { query },
});

const result = (callId: string, content = 'achados', url = 'https://a.com/'): Part => ({
  type: 'tool_result',
  callId,
  content,
  sources: [{ title: 'A', url }],
  failures: [],
  error: null,
});

/** Pergunta, resposta com uma Busca e pergunta seguinte. */
const withSearch = (answer: Part[], overrides: Partial<Message> = {}): Message[] => [
  makeMessage({ id: 'u1', conversationId, seq: 1, role: 'user', parts: [text('q1')] }),
  makeMessage({ id: 'a1', conversationId, seq: 2, role: 'assistant', parts: answer, ...overrides }),
  makeMessage({ id: 'u2', conversationId, seq: 3, role: 'user', parts: [text('q2')] }),
];

const searched: Part[] = [text('vou buscar'), call('t1'), result('t1'), text('achei')];

describe('selectHistory com Ferramentas', () => {
  it('desdobra as Rodadas da resposta do mesmo Provedor em assistant e user', () => {
    const request = select({
      messages: withSearch(searched),
      toolSpace: 40_000,
    });

    expect(request.messages).toEqual([
      { role: 'user', parts: [text('q1')] },
      { role: 'assistant', parts: [text('vou buscar'), call('t1')] },
      {
        role: 'user',
        parts: [
          {
            type: 'tool_result',
            callId: 't1',
            content: 'achados',
            isError: false,
            sources: [{ title: 'A', url: 'https://a.com/' }],
          },
        ],
      },
      { role: 'assistant', parts: [text('achei')] },
      { role: 'user', parts: [text('q2')] },
    ]);
  });

  it('corta a resposta interrompida a partir da chamada sem resultado', () => {
    const request = select({
      messages: withSearch([call('t1'), result('t1'), text('meio'), call('t2'), text('perdido')], {
        status: 'interrupted',
      }),
      toolSpace: 40_000,
    });

    const shape = request.messages
      .slice(1, -1)
      .map(({ role, parts }) => [role, parts.map((part) => part.type)]);
    expect(shape).toEqual([
      ['assistant', ['tool_call']],
      ['user', ['tool_result']],
      ['assistant', ['text']],
    ]);
  });
});

describe('Instruções', () => {
  it('vão em system, fora das Mensagens', async () => {
    const request = await toChatRequest(
      select({
        messages: [message('1', 1, 'user', 'oi')],
        instructions: 'responda curto',
      }),
      async () => [],
      [],
    );

    expect(request.system).toBe('responda curto');
    expect(request.messages).toEqual([{ role: 'user', parts: [text('oi')] }]);
  });
});
