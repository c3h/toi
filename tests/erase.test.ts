import { describe, expect, it } from 'vitest';
import { eraseAll, eraseConversations } from '../src/app/erase';
import {
  makeConversation,
  makeMessage,
  MemoryCredentialStore,
  MemorySettingsStore,
  MemoryStore,
} from './helpers';

const seed = async () => {
  const store = new MemoryStore();
  const credentials = new MemoryCredentialStore();
  const settings = new MemorySettingsStore();

  await store.putConversation(makeConversation('c1'));
  await store.putMessage(
    makeMessage({
      id: 'm1',
      conversationId: 'c1',
      seq: 1,
      role: 'user',
      parts: [{ type: 'text', text: 'oi' }],
    }),
  );
  await credentials.set('anthropic', 'sk-test');
  settings.values.set('theme', 'dark');

  return { store, credentials, settings };
};

describe('erase', () => {
  it('apagar Conversas preserva a Chave e as Configurações', async () => {
    const { store, credentials, settings } = await seed();

    await eraseConversations(store);

    expect(await store.listConversations()).toEqual([]);
    expect(await store.listMessages('c1')).toEqual([]);
    expect(await credentials.get('anthropic')).toBe('sk-test');
    expect(settings.values.get('theme')).toBe('dark');
  });

  it('apagar tudo compõe Conversas, Configurações e Chave', async () => {
    const { store, credentials, settings } = await seed();

    await eraseAll({ store, credentials, settings });

    expect(await store.listConversations()).toEqual([]);
    expect(await store.listMessages('c1')).toEqual([]);
    expect(await credentials.get('anthropic')).toBeNull();
    expect(settings.values.size).toBe(0);
  });
});
