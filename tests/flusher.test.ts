import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlusher } from '../src/app/flusher';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createFlusher', () => {
  it('grava depois do intervalo e coalesce pushes', async () => {
    const saved: number[] = [];
    const flusher = createFlusher(async (value: number) => {
      saved.push(value);
    }, 300);

    flusher.push(1);
    flusher.push(2);

    expect(saved).toEqual([]);

    await vi.advanceTimersByTimeAsync(300);

    expect(saved).toEqual([2]);
  });
});
