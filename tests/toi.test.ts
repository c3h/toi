import { describe, expect, it } from 'vitest';
import type { HistoryExport } from '../src/app/export';
import { createToi, type ToiDeps } from '../src/app/toi';
import { tinyfishInfo } from '../src/adapters/services/tinyfish/info';
import {
  baseDeps,
  FakeWebTools,
  gatedProvider,
  MemoryCredentialStore,
  MemorySettingsStore,
  providersOf,
  replyEvents,
  ScriptedProvider,
  sendInput,
} from './helpers';

const setup = async () => {
  const { store, deps: flow } = await baseDeps();
  const credentials = new MemoryCredentialStore();
  await credentials.set('anthropic', 'sk-test');
  const settings = new MemorySettingsStore();

  const deps: ToiDeps = {
    ...flow,
    credentials,
    settings,
    providers: providersOf(() => new ScriptedProvider([])),
    service: { info: tinyfishInfo, create: () => new FakeWebTools() },
  };

  return { store, credentials, settings, deps };
};

describe('createToi', () => {
  it('apagar tudo remove Conversas, Configurações e as duas Chaves e desconecta', async () => {
    const { store, credentials, settings, deps } = await setup();
    await credentials.set('tinyfish', 'tf-key');
    settings.values.set('theme', 'dark');

    const toi = await createToi(deps);
    expect(toi.connected()).toBe(true);
    expect(toi.serviceConnected()).toBe(true);

    await toi.eraseAll();

    expect(await store.listConversations()).toEqual([]);
    expect(await credentials.get('anthropic')).toBeNull();
    expect(await credentials.get('tinyfish')).toBeNull();
    expect(settings.values.size).toBe(0);
    expect(toi.connected()).toBe(false);
    expect(toi.serviceConnected()).toBe(false);
  });

  it('apagar a Conversa em voo para o Fluxo antes de apagar', async () => {
    const { store, deps } = await setup();

    const { provider, delta } = gatedProvider();
    const toi = await createToi({ ...deps, providers: providersOf(() => provider) });

    const pending = toi.flow.send(sendInput());
    await delta;

    await toi.deleteConversation('c1');

    expect((await pending).message.status).toBe('interrupted');
    expect(await store.listMessages('c1')).toEqual([]);
  });

  it('exporta o histórico sem a Chave', async () => {
    const { deps } = await setup();

    const toi = await createToi({
      ...deps,
      providers: providersOf(() => new ScriptedProvider(replyEvents())),
    });
    await toi.flow.send(sendInput());

    const file = await (await toi.exportHistory()).text();
    const exported = JSON.parse(file) as HistoryExport;

    expect(exported).toMatchObject({ format: 'toi.history', version: 1, exportedAt: 50_000 });
    expect(exported.conversations).toHaveLength(1);
    expect(
      exported.conversations[0]?.messages.map((message) => [message.role, message.parts]),
    ).toEqual([
      ['user', [{ type: 'text', text: 'Pergunta' }]],
      ['assistant', [{ type: 'text', text: 'Olá' }]],
    ]);
    expect(file).not.toContain('sk-test');
  });
});
