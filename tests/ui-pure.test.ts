import { describe, expect, it } from 'vitest';
import { splitBlocks } from '../src/ui/blocks';
import { keepUnchanged, mergeMessages } from '../src/ui/merge';
import type { Message } from '../src/domain/message';
import { makeMessage } from './helpers';

const message = (id: string, seq: number, status: Message['status'], text = ''): Message =>
  makeMessage({
    id,
    conversationId: 'c1',
    seq,
    role: 'assistant',
    status,
    parts: text ? [{ type: 'text', text }] : [],
  });

describe('splitBlocks', () => {
  it('corta em linha em branco', () => {
    expect(splitBlocks('# Título\n\nUm parágrafo\nque continua.\n\n- a\n- b')).toEqual([
      '# Título',
      'Um parágrafo\nque continua.',
      '- a\n- b',
    ]);
  });

  it('não corta dentro de bloco de código, nem aberto', () => {
    const fenced = '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nDepois';
    expect(splitBlocks(fenced)).toEqual(['```ts\nconst a = 1;\n\nconst b = 2;\n```', 'Depois']);
    expect(splitBlocks('Antes\n\n```\nabc\n\ndef')).toEqual(['Antes', '```\nabc\n\ndef']);
  });

  it('mantém continuação recuada no item de lista', () => {
    expect(splitBlocks('1. item\n\n    continuação\n\nfim')).toEqual([
      '1. item\n\n    continuação',
      'fim',
    ]);
  });
});

describe('mergeMessages', () => {
  it('a cópia em Fluxo vence o store atrasado', () => {
    const live = new Map([['m1', message('m1', 1, 'streaming', 'mais texto')]]);
    const merged = mergeMessages([message('m1', 1, 'streaming', 'texto')], live);

    expect(merged[0]?.parts).toEqual([{ type: 'text', text: 'mais texto' }]);
    expect(live.has('m1')).toBe(true);
  });

  it('fechada aqui antes do flush, a cópia local ainda vence', () => {
    const live = new Map([['m1', message('m1', 1, 'complete', 'fim')]]);
    expect(mergeMessages([message('m1', 1, 'streaming')], live)[0]?.status).toBe('complete');
  });

  it('com os dois fechados, o store volta a valer e a cópia sai', () => {
    const live = new Map([['m1', message('m1', 1, 'failed')]]);
    const merged = mergeMessages([message('m1', 1, 'complete', 'de outra aba')], live);

    expect(merged[0]?.status).toBe('complete');
    expect(live.size).toBe(0);
  });
});

describe('keepUnchanged', () => {
  it('reaproveita a Mensagem fechada e troca a que mudou', () => {
    const closed = message('m1', 1, 'complete', 'antes');
    const streaming = message('m2', 2, 'streaming', 'parte');
    const next = [{ ...closed }, message('m2', 2, 'streaming', 'parte e mais')];

    const kept = keepUnchanged([closed, streaming], next);

    expect(kept[0]).toBe(closed);
    expect(kept[1]).toBe(next[1]);
  });

  it('tentar de novo troca o objeto mesmo sem passar por streaming', () => {
    const failed = { ...message('m1', 1, 'failed'), completedAt: 1 };
    const again = { ...message('m1', 1, 'failed'), completedAt: 2 };

    expect(keepUnchanged([failed], [again])[0]).toBe(again);
  });
});
