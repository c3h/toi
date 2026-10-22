import { describe, expect, it } from 'vitest';
import { WebLocks } from '../src/adapters/locks/web';
import { createToi, type ToiDeps } from '../src/app/toi';
import {
  deferred,
  FailingProvider,
  flowDeps,
  gatedProvider,
  makeConversation,
  MemoryCredentialStore,
  MemorySettingsStore,
  MemoryStore,
  providersOf,
  replyEvents,
  ScriptedProvider,
  testModel,
} from './helpers';

const setup = async () => {
  const { store, clock, deps: flow } = flowDeps();
  const credentials = new MemoryCredentialStore();
  const settings = new MemorySettingsStore();

  const deps: ToiDeps = {
    ...flow,
    credentials,
    settings,
    providers: providersOf(() => new ScriptedProvider([])),
  };

  return { store, credentials, settings, clock, deps };
};

describe('createToi', () => {
  it('valida a Chave, grava e conecta', async () => {
    const { credentials, deps } = await setup();
    const toi = await createToi(deps);

    const models = await toi.connect('anthropic', '  sk-test  ');

    expect(models).toEqual([testModel]);
    expect(await credentials.get('anthropic')).toBe('sk-test');
    expect(toi.connected()).toBe(true);
  });

  it('mantém a Chave anterior quando a nova Chave falha', async () => {
    const { credentials, deps } = await setup();
    const toi = await createToi({
      ...deps,
      providers: providersOf((key) =>
        key === 'sk-bad' ? new FailingProvider([]) : new ScriptedProvider([]),
      ),
    });

    await toi.connect('anthropic', 'sk-good');

    await expect(toi.connect('anthropic', 'sk-bad')).rejects.toMatchObject({ code: 'invalid_credential' });

    expect(await credentials.get('anthropic')).toBe('sk-good');
    expect(toi.connected()).toBe(true);
  });

  it('apagar tudo remove Conversas, Configurações e Chave e desconecta', async () => {
    const { store, credentials, settings, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));
    settings.values.set('theme', 'dark');

    const toi = await createToi(deps);
    expect(toi.connected()).toBe(true);

    await toi.eraseAll();

    expect(await store.listConversations()).toEqual([]);
    expect(await credentials.get('anthropic')).toBeNull();
    expect(settings.values.size).toBe(0);
    expect(toi.connected()).toBe(false);
  });

  it('apagar outra Conversa não interrompe o Fluxo em voo', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));
    await store.putConversation(makeConversation('c2'));

    const { provider, delta } = gatedProvider();
    const toi = await createToi({ ...deps, providers: providersOf(() => provider) });

    const pending = toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel, effort: 'low' });
    await delta;

    await toi.deleteConversation('c2');

    expect(toi.flow.active()).toBe('c1');
    expect(await store.getConversation('c2')).toBeNull();

    await toi.flow.stop();
    expect((await pending).message.status).toBe('interrupted');
  });

  it('apagar a Conversa em voo para o Fluxo antes de apagar', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const { provider, delta } = gatedProvider();
    const toi = await createToi({ ...deps, providers: providersOf(() => provider) });

    const pending = toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel, effort: 'low' });
    await delta;

    await toi.deleteConversation('c1');

    expect((await pending).message.status).toBe('interrupted');
    expect(await store.listMessages('c1')).toEqual([]);
  });

  it('apagar tudo recusa novo envio enquanto limpa', async () => {
    class GatedStore extends MemoryStore {
      release: () => void = () => undefined;

      override async clearConversations(): Promise<void> {
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
        await super.clearConversations();
      }
    }

    const { credentials, deps } = await setup();
    const store = new GatedStore();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const toi = await createToi({ ...deps, store });
    const erasing = toi.eraseAll();

    await expect(
      toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel, effort: 'low' }),
    ).rejects.toMatchObject({ code: 'flow_busy' });

    store.release();
    await erasing;

    expect(await store.listMessages('c1')).toEqual([]);
    await expect(
      toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel, effort: 'low' }),
    ).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('apagar Conversas recusa enquanto outra aba tem Fluxo em voo', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const { provider, delta } = gatedProvider();
    const tabA = await createToi({ ...deps, providers: providersOf(() => provider) });
    const tabB = await createToi(deps);

    const pending = tabA.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel, effort: 'low' });
    await delta;

    await expect(tabB.eraseConversations()).rejects.toMatchObject({ code: 'flow_busy' });
    await expect(tabB.deleteConversation('c1')).rejects.toMatchObject({ code: 'flow_busy' });
    expect(await store.getConversation('c1')).not.toBeNull();

    await tabA.flow.stop();
    await pending;

    await tabB.eraseConversations();
    expect(await store.listConversations()).toEqual([]);
  });

  it('exporta o histórico sem a Chave', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-secret');
    await store.putConversation(makeConversation('c1'));

    const toi = await createToi({
      ...deps,
      providers: providersOf(() => new ScriptedProvider(replyEvents())),
    });
    await toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel, effort: 'low' });

    const exported = await toi.exportHistory();

    expect(exported).toMatchObject({ format: 'toi.history', version: 1, exportedAt: 50_000 });
    expect(exported.conversations).toHaveLength(1);
    expect(
      exported.conversations[0]?.messages.map((message) => [message.role, message.parts]),
    ).toEqual([
      ['user', [{ type: 'text', text: 'Pergunta' }]],
      ['assistant', [{ type: 'text', text: 'Olá' }]],
    ]);
    expect(JSON.stringify(exported)).not.toContain('sk-secret');
  });

  it('com Web Locks reais, apagar Conversas para o próprio Fluxo e limpa', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const { provider, delta } = gatedProvider();
    const toi = await createToi({
      ...deps,
      locks: new WebLocks(navigator.locks),
      providers: providersOf(() => provider),
    });

    const pending = toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel, effort: 'low' });
    await delta;

    await toi.eraseConversations();

    expect((await pending).message.status).toBe('interrupted');
    expect(await store.listConversations()).toEqual([]);
  });

  it('trocar Modelo e renomear durante o Fluxo não são desfeitos quando a resposta termina', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const delta = deferred();
    const release = deferred();
    const provider = new ScriptedProvider(async function* () {
      yield* replyEvents().slice(0, 2);
      delta.resolve();
      await release.promise;
      yield { type: 'finished' } as const;
    });
    const toi = await createToi({ ...deps, providers: providersOf(() => provider) });

    const pending = toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel, effort: 'low' });
    await delta.promise;
    await toi.changeModel('c1', { provider: 'anthropic', id: 'claude-outro' });
    await toi.renameConversation('c1', 'Renomeada');
    release.resolve();

    expect((await pending).message.status).toBe('complete');
    expect(await store.getConversation('c1')).toMatchObject({
      model: 'claude-outro',
      title: 'Renomeada',
    });
  });
});
