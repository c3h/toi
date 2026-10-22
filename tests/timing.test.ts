import { describe, expect, it } from 'vitest';
import { timingOf } from '../src/domain/message';
import { makeMessage, usage } from './helpers';

const answer = makeMessage({
  id: 'm1',
  conversationId: 'c1',
  seq: 2,
  role: 'assistant',
  createdAt: 1_000,
  firstTokenAt: 1_800,
  completedAt: 3_500,
  usage: usage(10, 50),
});

describe('timingOf', () => {
  it('mede a espera até o primeiro delta e a vazão sobre a resposta inteira', () => {
    expect(timingOf(answer)).toEqual({ firstTokenMs: 800, tokensPerSecond: 20 });
  });
});
