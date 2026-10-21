import { appError } from '../domain/error';
import { ANTHROPIC_PROVIDER } from '../domain/ids';
import type { Model } from '../domain/model';
import type { ChatProvider } from '../ports/chat-provider';
import type { CredentialStore } from '../ports/credential-store';

export interface ConnectDeps {
  credentials: CredentialStore;
  createProvider: (apiKey: string) => ChatProvider;
}

export interface Connected {
  provider: ChatProvider;
  models: Model[];
}

/**
 * Valida a Chave contra `listModels` antes de gravá-la. Se a validação falhar,
 * nada é persistido e a Chave anterior permanece.
 */
export const connect = async (
  deps: ConnectDeps,
  apiKey: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<Connected> => {
  const key = apiKey.trim();
  if (!key) throw appError('invalid_credential');

  const provider = deps.createProvider(key);
  const models = await provider.listModels(signal);
  await deps.credentials.set(ANTHROPIC_PROVIDER, key);

  return { provider, models };
};

export const disconnect = (deps: Pick<ConnectDeps, 'credentials'>): Promise<void> =>
  deps.credentials.delete(ANTHROPIC_PROVIDER);
