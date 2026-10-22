import { describe, expect, it } from 'vitest';
import { timingOf, type Message } from '../src/domain/message';
import { makeMessage, usage } from './helpers';

const answer = (overrides: Partial<Message> = {}): Message =>
  makeMessage({
    id: 'm1',
    conversationId: 'c1',
    seq: 2,
    role: 'assistant',
    createdAt: 1_000,
    firstTokenAt: 1_800,
    completedAt: 3_500,
    usage: usage(10, 50),
    ...overrides,
  });

describe('timingOf', () => {
  it('mede a espera até o primeiro delta e a vazão sobre a resposta inteira', () => {
    expect(timingOf(answer())).toEqual({ firstTokenMs: 800, tokensPerSecond: 20 });
  });

  it('não infla a vazão quando o raciocínio oculto atrasa o texto', () => {
    // 859 de saída, dos quais só ~230 visíveis: o resto foi gerado antes do primeiro delta.
    const timing = timingOf(
      answer({ createdAt: 0, firstTokenAt: 4_200, completedAt: 5_780, usage: usage(23, 859) }),
    );

    expect(timing?.firstTokenMs).toBe(4_200);
    expect(timing?.tokensPerSecond).toBeCloseTo(148.6, 1);
  });

  it('não mede o que não terminou em complete', () => {
    expect(timingOf(answer({ status: 'interrupted' }))).toBeNull();
    expect(timingOf(answer({ status: 'streaming', completedAt: null }))).toBeNull();
  });

  it('não mede sem primeiro token', () => {
    expect(timingOf(answer({ firstTokenAt: null }))).toBeNull();
  });

  it('deixa a vazão sem medida quando a resposta não tem duração', () => {
    expect(timingOf(answer({ createdAt: 1_800, completedAt: 1_800 }))).toEqual({
      firstTokenMs: 0,
      tokensPerSecond: null,
    });
  });
});
