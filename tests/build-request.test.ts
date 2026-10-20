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

const estimator = { estimate: (text: string) => text.length };

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
      estimator,
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
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
      estimator,
    });

    expect(request.messages).toEqual([{ role: 'user', content: 'pergunta' }]);
  });

  it('recusa histórico que não termine com o user', () => {
    expect(() =>
      buildRequest({
        messages: [message('1', 1, 'assistant', 'sem pergunta')],
        model: model(),
        estimator,
      }),
    ).toThrow(/terminar com uma Mensagem do user/);
  });

  it('limita maxTokens ao teto do Modelo', () => {
    const high = buildRequest({
      messages: [message('1', 1, 'user', 'oi')],
      model: model({ maxTokens: 100_000 }),
      estimator,
    });
    expect(high.request.maxTokens).toBe(8_192);

    const low = buildRequest({
      messages: [message('1', 1, 'user', 'oi')],
      model: model({ maxTokens: 4_096 }),
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
      estimator,
    });

    expect(truncated).toBe(true);
    expect(request.messages).toEqual([
      { role: 'user', content: 'a'.repeat(10) },
      { role: 'assistant', content: 'b'.repeat(10) },
      { role: 'user', content: 'e'.repeat(10) },
    ]);
  });

  it('não trunca quando cabe no orçamento', () => {
    const { truncated } = buildRequest({
      messages: [message('1', 1, 'user', 'oi')],
      model: model(),
      estimator,
    });

    expect(truncated).toBe(false);
  });
});
