import type { ConversationStore } from '../ports/conversation-store';
import type { CredentialStore } from '../ports/credential-store';
import type { SettingsStore } from '../ports/settings-store';
import { disconnect } from './connect';

export interface EraseDeps {
  store: ConversationStore;
  credentials: CredentialStore;
  settings: SettingsStore;
}

export const eraseConversations = (store: ConversationStore): Promise<void> =>
  store.clearConversations();

export const eraseAll = async (deps: EraseDeps): Promise<void> => {
  await Promise.all([
    deps.store.clearConversations(),
    deps.settings.clear(),
    disconnect(deps),
  ]);
};
