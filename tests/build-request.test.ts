import { describe, expect, it } from 'vitest';
import { buildRequest } from '../src/app/build-request';
import type { Message } from '../src/domain/message';
import type { Model } from '../src/domain/model';
import { makeMessage, testModel } from './helpers';

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

const estimator = { estimate: (value: string) => value.length };

const text = (value: string) => ({ type: 'text' as const, text: value });

const model = (overrides: Partial<Model> = {}): Model => ({ ...testModel, ...overrides });

describe('buildRequest', () => {
  it('funde mensagens consecutivas do mesmo papel e preserva a ordem', () => {
    const { request } = buildRequest({
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
    const { request } = buildRequest({
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

  it('recusa histórico que não termine com o user', () => {
    expect(() =>
      buildRequest({
        messages: [message('1', 1, 'assistant', 'sem pergunta')],
        model: model(),
        effort: 'low',
        estimator,
      }),
    ).toThrow(/terminar com uma Mensagem do user/);
  });

  it('limita maxTokens ao teto do Modelo', () => {
    const high = buildRequest({
      messages: [message('1', 1, 'user', 'oi')],
      model: model({ maxTokens: 100_000 }),
      effort: 'low',
      estimator,
    });
    expect(high.request.maxTokens).toBe(8_192);

    const low = buildRequest({
      messages: [message('1', 1, 'user', 'oi')],
      model: model({ maxTokens: 4_096 }),
      effort: 'low',
      estimator,
    });
    expect(low.request.maxTokens).toBe(4_096);
  });

  it('trunca turnos do meio preservando o primeiro turno e o atual', () => {
    const { request, truncated } = buildRequest({
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

    expect(truncated).toBe(true);
    expect(request.messages).toEqual([
      { role: 'user', parts: [text('a'.repeat(10))] },
      { role: 'assistant', parts: [text('b'.repeat(10))] },
      { role: 'user', parts: [text('e'.repeat(10))] },
    ]);
  });

  it('não trunca quando cabe no orçamento', () => {
    const { truncated } = buildRequest({
      messages: [message('1', 1, 'user', 'oi')],
      model: model(),
      effort: 'low',
      estimator,
    });

    expect(truncated).toBe(false);
  });

  it('envia só Partes de texto, aparadas, e não reenvia raciocínio', () => {
    const { request } = buildRequest({
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
