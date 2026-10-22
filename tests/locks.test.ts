import { describe, expect, it } from 'vitest';
import { WebLocks } from '../src/adapters/locks/web';
import type { Locks } from '../src/ports/locks';
import { MemoryLocks } from './helpers';

const describeLocks = (name: string, open: () => Locks): void => {
  describe(name, () => {
    it('exclusive recusa um segundo dono até soltar', async () => {
      const locks = open();
      const release = await locks.tryAcquire('a');

      expect(release).not.toBeNull();
      expect(await locks.tryAcquire('a')).toBeNull();
      expect(await locks.tryAcquire('b')).not.toBeNull();

      await release!();
      const again = await locks.tryAcquire('a');
      expect(again).not.toBeNull();
      await again!();
    });

    it('shared convive com shared e bloqueia exclusive', async () => {
      const locks = open();
      const first = await locks.tryAcquire('h', 'shared');
      const second = await locks.tryAcquire('h', 'shared');

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(await locks.tryAcquire('h', 'exclusive')).toBeNull();

      await first!();
      expect(await locks.tryAcquire('h', 'exclusive')).toBeNull();

      await second!();
      const exclusive = await locks.tryAcquire('h', 'exclusive');
      expect(exclusive).not.toBeNull();
      expect(await locks.tryAcquire('h', 'shared')).toBeNull();
      await exclusive!();
    });
  });
};

let names = 0;

/** Prefixa os nomes: `navigator.locks` é um só para o processo inteiro. */
const isolated = (locks: Locks): Locks => {
  const prefix = `test-${(names += 1)}:`;
  return { tryAcquire: (name, mode) => locks.tryAcquire(prefix + name, mode) };
};

describeLocks('MemoryLocks', () => new MemoryLocks());
describeLocks('WebLocks (navigator.locks do Node)', () => isolated(new WebLocks(navigator.locks)));
