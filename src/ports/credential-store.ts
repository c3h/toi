import type { CredentialOwner } from '../domain/ids';

/** Uma Chave por dono: cada Provedor e cada Serviço. */
export interface CredentialStore {
  get(owner: CredentialOwner): Promise<string | null>;
  set(owner: CredentialOwner, key: string): Promise<void>;
  delete(owner: CredentialOwner): Promise<void>;
  /** Todas as Chaves, inclusive de dono que não está mais registrado. */
  clear(): Promise<void>;
}
