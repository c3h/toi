import type { CredentialOwner } from '../../domain/ids';
import type { CredentialStore } from '../../ports/credential-store';
import type { ToiDatabase } from './db';

export class DexieCredentialStore implements CredentialStore {
  readonly #db: ToiDatabase;

  constructor(db: ToiDatabase) {
    this.#db = db;
  }

  async get(owner: CredentialOwner): Promise<string | null> {
    const row = await this.#db.credentials.get(owner);
    return row?.apiKey ?? null;
  }

  async set(owner: CredentialOwner, key: string): Promise<void> {
    await this.#db.credentials.put({ provider: owner, apiKey: key });
  }

  async delete(owner: CredentialOwner): Promise<void> {
    await this.#db.credentials.delete(owner);
  }

  async clear(): Promise<void> {
    await this.#db.credentials.clear();
  }
}
