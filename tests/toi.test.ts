import { describe, expect, it } from 'vitest';
import { WebLocks } from '../src/adapters/locks/web';
import { createToi, type ToiDeps } from '../src/app/toi';
import { appError } from '../src/domain/error';
import type { Model } from '../src/domain/model';
import {
  flowDeps,
  gatedProvider,
  makeConversation,
  makeMessage,
  MemoryCredentialStore,
  MemorySettingsStore,
  MemoryStore,
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
    createProvider: () => new ScriptedProvider([]),
  };

  return { store, credentials, settings, clock, deps };
};

class FailingProvider extends ScriptedProvider {
  override async listModels(): Promise<Model[]> {
    throw appError('invalid_credential');
  }
}

describe('createToi', () => {
  it('abre desconectado quando não há Chave', async () => {
    const { deps } = await setup();
    const toi = await createToi(deps);

    expect(toi.connected()).toBe(false);
    await expect(
      toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel }),
    ).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('valida a Chave, grava e conecta', async () => {
    const { credentials, deps } = await setup();
    const toi = await createToi(deps);

    const models = await toi.connect('  sk-test  ');

    expect(models).toEqual([testModel]);
    expect(await credentials.get('anthropic')).toBe('sk-test');
    expect(toi.connected()).toBe(true);
  });

  it('não grava a Chave quando a validação falha', async () => {
    const { credentials, deps } = await setup();
    const toi = await createToi({ ...deps, createProvider: () => new FailingProvider([]) });

    await expect(toi.connect('sk-bad')).rejects.toMatchObject({ code: 'invalid_credential' });

    expect(await credentials.get('anthropic')).toBeNull();
    expect(toi.connected()).toBe(false);
  });

  it('mantém a Chave anterior quando a nova Chave falha', async () => {
    const { credentials, deps } = await setup();
    const toi = await createToi({
      ...deps,
      createProvider: (key) =>
        key === 'sk-bad' ? new FailingProvider([]) : new ScriptedProvider([]),
    });

    await toi.connect('sk-good');

    await expect(toi.connect('sk-bad')).rejects.toMatchObject({ code: 'invalid_credential' });

    expect(await credentials.get('anthropic')).toBe('sk-good');
    expect(toi.connected()).toBe(true);
  });

  it('expõe o histórico pelas use cases', async () => {
    const { deps } = await setup();
    const toi = await createToi(deps);

    const conversation = await toi.createConversation(testModel.id);
    expect(conversation.title).toBe('Nova conversa');
    expect(await toi.listConversations()).toEqual([conversation]);
    expect(await toi.listMessages(conversation.id)).toEqual([]);

    const renamed = await toi.renameConversation(conversation.id, '  Outro   título ');
    expect(renamed?.title).toBe('Outro título');

    await toi.deleteConversation(conversation.id);
    expect(await toi.listConversations()).toEqual([]);
  });

  it('disconnect remove a Chave e desconecta', async () => {
    const { credentials, deps } = await setup();
    const toi = await createToi(deps);

    await toi.connect('sk-test');
    await toi.disconnect();

    expect(await credentials.get('anthropic')).toBeNull();
    expect(toi.connected()).toBe(false);
  });

  it('apagar Conversas preserva a Chave', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const toi = await createToi(deps);
    await toi.eraseConversations();

    expect(await store.listConversations()).toEqual([]);
    expect(await credentials.get('anthropic')).toBe('sk-test');
    expect(toi.connected()).toBe(true);
  });

  it('apagar Conversas para o Fluxo em andamento antes de limpar', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const { provider, delta } = gatedProvider();

    const toi = await createToi({ ...deps, createProvider: () => provider });

    const pending = toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
    await delta;

    await toi.eraseConversations();

    const result = await pending;
    expect(result.message.status).toBe('interrupted');
    expect(await store.listConversations()).toEqual([]);
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

  it('recupera Mensagem streaming órfã na abertura', async () => {
    const { store, clock, deps } = await setup();
    await store.putMessage(
      makeMessage({
        id: 'm1',
        conversationId: 'c1',
        seq: 1,
        role: 'assistant',
        status: 'streaming',
        stream: { owner: 'tab-a', heartbeatAt: clock.now() - 20_000 },
      }),
    );

    await createToi(deps);

    expect((await store.messages.get('m1'))?.status).toBe('interrupted');
    expect((await store.messages.get('m1'))?.stream).toBeNull();
  });

  it('apagar outra Conversa não interrompe o Fluxo em voo', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));
    await store.putConversation(makeConversation('c2'));

    const { provider, delta } = gatedProvider();
    const toi = await createToi({ ...deps, createProvider: () => provider });

    const pending = toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
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
    const toi = await createToi({ ...deps, createProvider: () => provider });

    const pending = toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
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
      toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel }),
    ).rejects.toMatchObject({ code: 'flow_busy' });

    store.release();
    await erasing;

    expect(await store.listMessages('c1')).toEqual([]);
    await expect(
      toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel }),
    ).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('apagar Conversas recusa enquanto outra aba tem Fluxo em voo', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const { provider, delta } = gatedProvider();
    const tabA = await createToi({ ...deps, createProvider: () => provider });
    const tabB = await createToi({ ...deps, owner: 'tab-b' });

    const pending = tabA.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
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
      createProvider: () => new ScriptedProvider(replyEvents()),
    });
    await toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });

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
      createProvider: () => provider,
    });

    const pending = toi.flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
    await delta;

    await toi.eraseConversations();

    expect((await pending).message.status).toBe('interrupted');
    expect(await store.listConversations()).toEqual([]);
  });
});
