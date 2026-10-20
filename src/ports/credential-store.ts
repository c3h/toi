import type { ProviderId } from '../domain/ids';

export interface CredentialStore {
  get(provider: ProviderId): Promise<string | null>;
  set(provider: ProviderId, key: string): Promise<void>;
  delete(provider: ProviderId): Promise<void>;
}
