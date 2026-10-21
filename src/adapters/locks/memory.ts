import type { LockMode, Locks, Release } from '../../ports/locks';

interface Holding {
  mode: LockMode;
  count: number;
}

/** Locks de uma única página. Fallback sem Web Locks e implementação dos testes. */
export class MemoryLocks implements Locks {
  readonly crossTab: boolean;
  readonly #held = new Map<string, Holding>();

  constructor({ crossTab = false }: { crossTab?: boolean } = {}) {
    this.crossTab = crossTab;
  }

  async tryAcquire(name: string, mode: LockMode = 'exclusive'): Promise<Release | null> {
    const current = this.#held.get(name);
    if (current && (mode === 'exclusive' || current.mode === 'exclusive')) return null;

    this.#held.set(name, { mode, count: (current?.count ?? 0) + 1 });

    let released = false;
    return async () => {
      if (released) return;
      released = true;

      const holding = this.#held.get(name);
      if (!holding || holding.count <= 1) this.#held.delete(name);
      else holding.count -= 1;
    };
  }
}
