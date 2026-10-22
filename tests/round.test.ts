import { describe, expect, it } from 'vitest';
import type { Message, Part } from '../src/domain/message';
import {
  applyEvent,
  closeRound,
  startRound,
  withoutPendingCalls,
  type Round,
} from '../src/domain/round';
import type { StreamEvent } from '../src/domain/stream';
import { makeMessage } from './helpers';

const draft = (parts: Part[] = []): Message =>
  makeMessage({
    id: 'a1',
    conversationId: 'c1',
    seq: 2,
    role: 'assistant',
    status: 'streaming',
    completedAt: null,
    parts,
  });

const run = (events: StreamEvent[], base: Part[] = []) =>
  events.reduce<{ message: Message; round: Round }>(
    (state, event, at) => applyEvent(state.message, state.round, event, 100 + at),
    { message: draft(base), round: startRound(base) },
  );

describe('applyEvent', () => {
  it('mostra texto a cada delta e marca o primeiro token', () => {
    const { message } = run([
      { type: 'part_started', index: 0, part: { type: 'text' } },
      { type: 'delta', index: 0, part: 'text', text: 'Ol' },
      { type: 'delta', index: 0, part: 'text', text: 'á' },
    ]);

    expect(message.parts).toEqual([{ type: 'text', text: 'Olá' }]);
    expect(message.firstTokenAt).toBe(101);
  });

  it('abre bloco de texto quando o delta chega sem part_started', () => {
    const { message } = run([{ type: 'delta', index: 0, part: 'text', text: 'oi' }]);
    expect(message.parts).toEqual([{ type: 'text', text: 'oi' }]);
  });

  it('só mostra raciocínio terminado e assinado', () => {
    const events: StreamEvent[] = [
      { type: 'part_started', index: 0, part: { type: 'reasoning' } },
      { type: 'delta', index: 0, part: 'reasoning', text: 'pensa' },
      { type: 'delta', index: 0, part: 'signature', text: 'sig' },
    ];

    expect(run(events).message.parts).toEqual([]);
    expect(run([...events, { type: 'part_finished', index: 0 }]).message.parts).toEqual([
      { type: 'reasoning', text: 'pensa', signature: 'sig' },
    ]);
  });

  it('só mostra a chamada de Ferramenta com o input fechado, na ordem dos índices', () => {
    const open: StreamEvent[] = [
      { type: 'part_started', index: 1, part: { type: 'tool_call', callId: 't1', tool: 'web_search' } },
      { type: 'delta', index: 1, part: 'input', text: '{"query":"co' },
      { type: 'part_started', index: 0, part: { type: 'text' } },
      { type: 'delta', index: 0, part: 'text', text: 'vou buscar' },
      { type: 'delta', index: 1, part: 'input', text: 'bre"}' },
    ];

    expect(run(open).message.parts).toEqual([{ type: 'text', text: 'vou buscar' }]);
    expect(run([...open, { type: 'part_finished', index: 1 }]).message.parts).toEqual([
      { type: 'text', text: 'vou buscar' },
      { type: 'tool_call', callId: 't1', tool: 'web_search', input: { query: 'cobre' } },
    ]);
  });

  it('mantém as Partes das Rodadas anteriores antes da Rodada atual', () => {
    const base: Part[] = [{ type: 'text', text: 'antes' }];
    const { message } = run([{ type: 'delta', index: 0, part: 'text', text: 'depois' }], base);

    expect(message.parts).toEqual([...base, { type: 'text', text: 'depois' }]);
  });
});

describe('closeRound', () => {
  it('devolve as chamadas completas e aponta input vazio como objeto vazio', () => {
    const { round } = run([
      { type: 'part_started', index: 0, part: { type: 'tool_call', callId: 't1', tool: 'web_search' } },
      { type: 'part_finished', index: 0 },
    ]);

    expect(closeRound(round)).toEqual({
      calls: [{ type: 'tool_call', callId: 't1', tool: 'web_search', input: {} }],
      broken: false,
    });
  });

  it.each([
    { caso: 'sem fim do bloco', events: [] as StreamEvent[] },
    {
      caso: 'JSON que não é objeto',
      events: [
        { type: 'delta', index: 0, part: 'input', text: '[1]' },
        { type: 'part_finished', index: 0 },
      ] as StreamEvent[],
    },
  ])('marca a Rodada quebrada com chamada $caso', ({ events }) => {
    const { round } = run([
      { type: 'part_started', index: 0, part: { type: 'tool_call', callId: 't1', tool: 'web_fetch' } },
      ...events,
    ]);

    expect(closeRound(round)).toEqual({ calls: [], broken: true });
  });
});

describe('withoutPendingCalls', () => {
  it('tira só as chamadas sem resultado', () => {
    const answered: Part = { type: 'tool_call', callId: 'a', tool: 'web_search', input: {} };
    const pending: Part = { type: 'tool_call', callId: 'b', tool: 'web_search', input: {} };
    const answer: Part = {
      type: 'tool_result',
      callId: 'a',
      content: '',
      sources: [],
      failures: [],
      error: null,
    };

    expect(withoutPendingCalls([answered, answer, pending])).toEqual([answered, answer]);
  });
});
