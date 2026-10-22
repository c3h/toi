import type { ProviderId } from '../../domain/ids';
import type { CredentialStore } from '../../ports/credential-store';
import type { ToiDatabase } from './db';

export class DexieCredentialStore implements CredentialStore {
  readonly #db: ToiDatabase;

  constructor(db: ToiDatabase) {
    this.#db = db;
  }

  async get(provider: ProviderId): Promise<string | null> {
    const row = await this.#db.credentials.get(provider);
    return row?.apiKey ?? null;
  }

  async set(provider: ProviderId, key: string): Promise<void> {
    await this.#db.credentials.put({ provider, apiKey: key });
  }

  async delete(provider: ProviderId): Promise<void> {
    await this.#db.credentials.delete(provider);
  }

  async clear(): Promise<void> {
    await this.#db.credentials.clear();
  }
}
