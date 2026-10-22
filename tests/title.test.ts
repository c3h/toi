import { describe, expect, it } from 'vitest';
import { titleFrom } from '../src/domain/conversation';

describe('titleFrom', () => {
  it('corta em limite de palavra e sinaliza', () => {
    const title = titleFrom('palavra '.repeat(10));

    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('pala…');
    expect(title.length).toBeLessThanOrEqual(61);
  });
});
