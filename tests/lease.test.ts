import { describe, expect, it } from 'vitest';
import { DEFAULT_LEASE_MS, isLeaseExpired, leaseOf } from '../src/domain/message';

describe('isLeaseExpired', () => {
  it('considera vencido quando não há lease', () => {
    expect(isLeaseExpired(null, 1_000)).toBe(true);
  });

  it('considera vivo dentro da janela', () => {
    expect(isLeaseExpired(leaseOf('tab-a', 1_000), 1_000 + DEFAULT_LEASE_MS - 1)).toBe(false);
  });

  it('considera vencido no limite', () => {
    expect(isLeaseExpired(leaseOf('tab-a', 1_000), 1_000 + DEFAULT_LEASE_MS)).toBe(true);
  });

  it('aceita uma janela explícita', () => {
    expect(isLeaseExpired(leaseOf('tab-a', 1_000), 1_500, 400)).toBe(true);
  });
});
