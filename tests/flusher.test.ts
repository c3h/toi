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

  it('flush grava na hora e espera a escrita', async () => {
    const saved: number[] = [];
    const flusher = createFlusher(async (value: number) => {
      saved.push(value);
    }, 60_000);

    flusher.push(7);
    await flusher.flush();

    expect(saved).toEqual([7]);
  });

  it('propaga falha de escrita no flush', async () => {
    const flusher = createFlusher(async () => {
      throw new Error('IndexedDB indisponível');
    }, 300);

    flusher.push(1);

    await expect(flusher.flush()).rejects.toThrow('IndexedDB indisponível');
    await expect(flusher.flush()).resolves.toBeUndefined();
  });
});
