import type { LockMode, Locks, Release } from '../../ports/locks';

/** `navigator.locks`: o navegador solta o lock quando a página morre. */
export class WebLocks implements Locks {
  readonly #api: LockManager;

  constructor(api: LockManager) {
    this.#api = api;
  }

  tryAcquire(name: string, mode: LockMode = 'exclusive'): Promise<Release | null> {
    return new Promise((resolve, reject) => {
      // `request` só resolve depois que o navegador soltou o lock.
      const settled: Promise<unknown> = this.#api
        .request(name, { mode, ifAvailable: true }, (lock) => {
          if (lock === null) {
            resolve(null);
            return undefined;
          }

          // O lock dura enquanto esta Promise estiver pendente.
          return new Promise<void>((release) =>
            resolve(async () => {
              release();
              await settled;
            }),
          );
        });

      settled.catch(reject);
    });
  }
}
