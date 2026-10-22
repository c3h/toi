import { describe, expect, it } from 'vitest';
import { cleanTitle, titleFrom } from '../src/domain/conversation';

describe('titleFrom', () => {
  it('corta em limite de palavra e sinaliza', () => {
    const title = titleFrom('palavra '.repeat(10));

    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('pala…');
    expect(title.length).toBeLessThanOrEqual(61);
  });
});

describe('cleanTitle', () => {
  it('tira aspas, marcação e ponto final; sem texto, não há Título', () => {
    expect(cleanTitle('"Receita de pão de fermentação natural."')).toBe(
      'Receita de pão de fermentação natural',
    );
    expect(cleanTitle('# **Dúvida sobre impostos**\n\nOutra linha')).toBe('Dúvida sobre impostos');
    expect(cleanTitle(' "" ')).toBeNull();
  });
});
