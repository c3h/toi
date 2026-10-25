import { describe, expect, it } from 'vitest';
import {
  continuationOf,
  elisionMarker,
  resultElisionMarker,
  selectHistory,
  toChatRequest,
  type SelectedMessage,
  type SelectedPart,
  type SelectHistoryInput,
} from '../src/app/build-request';
import type { AttachmentUpload } from '../src/domain/attachment';
import type { Message, Part } from '../src/domain/message';
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

  it('limita maxTokens ao teto do Modelo', () => {
    const high = select({
      messages: [message('1', 1, 'user', 'oi')],
      model: model({ maxTokens: 100_000 }),
    });
    expect(high.maxTokens).toBe(8_192);

    const low = select({
      messages: [message('1', 1, 'user', 'oi')],
      model: model({ maxTokens: 4_096 }),
    });
    expect(low.maxTokens).toBe(4_096);
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

  it('envia só Partes de texto, aparadas, e não reenvia raciocínio', () => {
    const request = select({
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

  it('com 1 milhão de tokens de contexto cabem 600 páginas', () => {
    const selected = select({
      messages: history(turn(1, [pdfFile('p1', 60)]), turn(2, [pdfFile('p2', 60)])),
      model: model({ maxInputTokens: 1_000_000 }),
    });

    expect(fileNames(selected.messages)).toEqual(['p1', 'p2']);
    expect(selected.truncated).toBeNull();
  });

  it('nunca tira Anexo do turno atual, mesmo com o histórico cheio', () => {
    const selected = select({
      messages: history(turn(1, [pdfFile('p1', 40)]), turn(2, [pdfFile('p2', 100)])),
    });

    expect(fileNames(selected.messages)).toEqual(['p2']);
  });

  it('tira um documento grande antes de cortar turnos de texto pelos tokens', () => {
    // O marcador custa ~120 tokens com este estimador; o documento, 250 de um orçamento de 240.
    const heavy = { estimate: (value: string) => value.length, estimateAttachment: () => 250 };

    const selected = select({
      messages: history(turn(1, [textFile('t1')]), turn(2, []), turn(3, [])),
      model: model({ maxInputTokens: 300 }),
      estimator: heavy,
    });

    expect(fileNames(selected.messages)).toEqual([]);
    expect(selected.messages).toHaveLength(5);
    expect(selected.truncated).toEqual({ turns: false, attachments: true, results: false });
  });
});

describe('toChatRequest', () => {
  it('busca só os Anexos que ficaram e os entrega com os bytes', async () => {
    const files = [imageFile('i1', 3), pdfFile('p1', 1, 4), textFile('t1', '# notas')];
    const blobs = new Map(files.map(({ attachment, blob }) => [attachment.id, blob]));
    const read: string[][] = [];

    const request = await toChatRequest(
      select({
        messages: history(turn(1, [pdfFile('velho', 100)]), turn(2, files)),
      }),
      async (ids) => {
        read.push(ids);
        return ids.map((id) => blobs.get(id)!);
      },
      [],
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

  it.each([
    { caso: 'sem Ferramentas no envio', toolSpace: null, overrides: {} },
    { caso: 'de outro Provedor', toolSpace: 40_000, overrides: { provider: 'outro' } },
  ])('volta só o texto da resposta $caso', ({ toolSpace, overrides }) => {
    const request = select({
      messages: withSearch(searched, overrides as Partial<Message>),
      toolSpace,
    });

    expect(request.messages[1]).toEqual({
      role: 'assistant',
      parts: [text('vou buscar'), text('achei')],
    });
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

  it.each<{ caso: string; answer: Part[]; expected: SelectedMessage[] }>([
    {
      caso: 'termina em resultado',
      answer: [text('vou buscar'), call('t1'), result('t1')],
      expected: [
        { role: 'user', parts: [text('q1')] },
        { role: 'assistant', parts: [text('vou buscar')] },
        { role: 'user', parts: [text('q2')] },
      ],
    },
    {
      caso: 'só tem a Rodada de Ferramenta',
      answer: [call('t1'), result('t1')],
      expected: [{ role: 'user', parts: [text('q1'), text('q2')] }],
    },
  ])('resposta antiga que $caso volta sem as Rodadas finais', ({ answer, expected }) => {
    const request = select({
      messages: withSearch(answer, { status: 'interrupted' }),
      toolSpace: 40_000,
    });

    expect(request.messages).toEqual(expected);
  });

  it('troca resultado antigo por marcador com as Fontes antes de cortar turnos', () => {
    // 80% de 500 são 400; o espaço das Rodadas leva 300 e sobram 100 ao histórico.
    const { truncated, messages } = select({
      messages: withSearch([call('t1'), result('t1', 'r'.repeat(1_000)), text('fim')]),
      model: model({ maxInputTokens: 500 }),
      toolSpace: 300,
    });

    expect(truncated).toEqual({ turns: false, attachments: false, results: true });
    expect(messages[2]!.parts[0]).toMatchObject({
      type: 'tool_result',
      content: resultElisionMarker([{ title: 'A', url: 'https://a.com/' }]),
    });
  });
});

describe('espaço das Rodadas', () => {
  it('sai do orçamento do histórico, sem passar da metade dele', () => {
    const spaceOf = (toolSpace: number | null) =>
      select({
        messages: [message('1', 1, 'user', 'oi')],
        model: model({ maxInputTokens: 100_000 }),
        toolSpace,
      }).toolSpace;

    expect(spaceOf(null)).toBeNull();
    expect(spaceOf(20_000)).toBe(20_000);
    expect(spaceOf(80_000)).toBe(40_000);
  });
});

describe('continuationOf', () => {
  it('devolve as Rodadas fechadas com o raciocínio e sem texto vazio', () => {
    const reasoning: Part = { type: 'reasoning', text: 'pensa', signature: 'sig' };

    expect(continuationOf([reasoning, text(' '), call('t1'), result('t1')])).toEqual([
      { role: 'assistant', parts: [reasoning, call('t1')] },
      {
        role: 'user',
        parts: [{ type: 'tool_result', callId: 't1', content: 'achados', isError: false }],
      },
    ]);
  });

  it('apara o texto como o turno seguinte o reenvia, para o cache não quebrar ali', () => {
    const answer = [text('\n vou buscar  \n'), call('t1'), result('t1'), text('achei')];
    const next = select({
      messages: withSearch(answer),
      toolSpace: 40_000,
    });

    const round = { role: 'assistant', parts: [text('vou buscar'), call('t1')] };
    expect(continuationOf(answer.slice(0, 3))[0]).toEqual(round);
    expect(next.messages[1]).toEqual(round);
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

  it('saem do orçamento: o turno do meio que cabia sem elas é cortado, e elas ficam', () => {
    // Um token por caractere; 80 de orçamento: os três turnos somam 70.
    const withInstructions = (instructions: string | null) =>
      select({
        messages: [
          message('1', 1, 'user', 'a'.repeat(10)),
          message('2', 2, 'assistant', 'b'.repeat(10)),
          message('3', 3, 'user', 'c'.repeat(20)),
          message('4', 4, 'assistant', 'd'.repeat(20)),
          message('5', 5, 'user', 'e'.repeat(10)),
        ],
        model: model({ maxInputTokens: 100 }),
        instructions,
      });

    expect(withInstructions(null).truncated).toBeNull();

    const cut = withInstructions('x'.repeat(20));
    expect(cut.truncated).toEqual({ turns: true, attachments: false, results: false });
    expect(cut.messages.map(({ parts }) => parts)).toEqual([
      [text('a'.repeat(10))],
      [text('b'.repeat(10))],
      [text('e'.repeat(10))],
    ]);
    expect(cut.instructions).toBe('x'.repeat(20));
  });
});
