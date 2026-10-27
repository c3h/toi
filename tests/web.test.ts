import { describe, expect, it } from 'vitest';
import { canonicalUrl, eligibleUrls } from '../src/domain/web';
import type { Part } from '../src/domain/message';
import { makeMessage } from './helpers';

const result = (...urls: string[]): Part => ({
  type: 'tool_result',
  callId: 'call',
  content: 'conteúdo',
  sources: urls.map((url) => ({ title: url, url })),
  failures: [],
  error: null,
});

describe('canonicalUrl', () => {
  it('recusa outro esquema, credencial embutida e texto que não é URL', () => {
    expect(canonicalUrl('ftp://exemplo.com/a')).toBeNull();
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('https://user:pass@exemplo.com/')).toBeNull();
    expect(canonicalUrl('não é url')).toBeNull();
  });
});

describe('eligibleUrls', () => {
  it('junta Fontes gravadas, URLs da pessoa e Fontes do draft, e ignora o texto do assistant', () => {
    const history = [
      makeMessage({
        id: 'u1',
        conversationId: 'c1',
        seq: 1,
        role: 'user',
        parts: [{ type: 'text', text: 'leia pessoa.com/post' }],
      }),
      makeMessage({
        id: 'a1',
        conversationId: 'c1',
        seq: 2,
        role: 'assistant',
        parts: [result('http://fonte.com/a#topo'), { type: 'text', text: 'veja modelo.com/x' }],
      }),
    ];

    expect([...eligibleUrls(history, [result('https://draft.com/b')])].sort()).toEqual([
      'https://draft.com/b',
      'https://fonte.com/a',
      'https://pessoa.com/post',
    ]);
  });
});
