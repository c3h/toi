import { describe, expect, it, vi } from 'vitest';
import { WebLocks } from '../src/adapters/locks/web';
import type { HistoryExport } from '../src/app/export';
import { createToi, type ToiDeps } from '../src/app/toi';
import { tinyfishInfo } from '../src/adapters/services/tinyfish/info';
import { appError } from '../src/domain/error';
import { DEFAULT_TOOL_SPACE } from '../src/domain/web';
import type { StreamEvent } from '../src/domain/stream';
import type { ChatProvider, ChatRequest } from '../src/ports/chat-provider';
import type { ServiceAdapter } from '../src/ports/web-tools';
import {
  deferred,
  FailingProvider,
  FakeWebTools,
  flowDeps,
  gatedProvider,
  makeConversation,
  makeModel,
  MemoryCredentialStore,
  MemorySettingsStore,
  MemoryStore,
  providersOf,
  replyEvents,
  ScriptedProvider,
  sendInput,
  testModel,
} from './helpers';

/** Nenhum destes testes desiste de validar uma Chave. */
const signal = new AbortController().signal;

const setup = async () => {
  const { store, clock, deps: flow } = flowDeps();
  const credentials = new MemoryCredentialStore();
  const settings = new MemorySettingsStore();

  const deps: ToiDeps = {
    ...flow,
    credentials,
    settings,
    providers: providersOf(() => new ScriptedProvider([])),
    service: { info: tinyfishInfo, create: () => new FakeWebTools() },
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

  it('valida a Chave do Serviço antes de gravar e mantém a anterior quando a nova falha', async () => {
    const { credentials, deps } = await setup();
    const created: string[] = [];
    const service: ServiceAdapter = {
      info: tinyfishInfo,
      create: (key) => {
        created.push(key);
        const tools = new FakeWebTools();
        if (key === 'tf-bad') tools.verifyAnswer = appError('tool_invalid_credential');
        return tools;
      },
    };
    const toi = await createToi({ ...deps, service });
    expect(toi.serviceConnected()).toBe(false);

    await toi.connectService('  tf-good  ', signal);
    await expect(toi.connectService('tf-bad', signal)).rejects.toMatchObject({
      code: 'tool_invalid_credential',
    });

    expect(created).toEqual(['tf-good', 'tf-bad']);
    expect(await credentials.get('tinyfish')).toBe('tf-good');
    expect(toi.serviceConnected()).toBe(true);
  });

  it('desistir durante a validação da Chave do Serviço não a grava', async () => {
    const { credentials, deps } = await setup();
    const controller = new AbortController();
    const service: ServiceAdapter = {
      info: tinyfishInfo,
      create: () => {
        const tools = new FakeWebTools();
        // A validação passa, mas a pessoa desistiu enquanto ela corria.
        tools.verifyAnswer = async () => controller.abort();
        return tools;
      },
    };
    const toi = await createToi({ ...deps, service });

    await expect(toi.connectService('tf-key', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(await credentials.get('tinyfish')).toBeNull();
    expect(toi.serviceConnected()).toBe(false);
  });

  it('carrega a Chave do Serviço na abertura e apagar tudo a remove', async () => {
    const { credentials, deps } = await setup();
    await credentials.set('tinyfish', 'tf-key');

    const toi = await createToi(deps);
    expect(toi.serviceConnected()).toBe(true);

    await toi.eraseAll();

    expect(await credentials.get('tinyfish')).toBeNull();
    expect(toi.serviceConnected()).toBe(false);
  });

  it('remover a Chave do Serviço desconecta só ele', async () => {
    const { credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await credentials.set('tinyfish', 'tf-key');
    const toi = await createToi(deps);

    await toi.disconnectService();

    expect(await credentials.get('tinyfish')).toBeNull();
    expect(toi.serviceConnected()).toBe(false);
    expect(toi.connected()).toBe(true);
  });

  it('o espaço da busca começa no padrão e guarda a escolha', async () => {
    const { deps } = await setup();
    const toi = await createToi(deps);

    expect(await toi.toolSpace()).toBe(DEFAULT_TOOL_SPACE);
    await toi.saveToolSpace(80_000);
    expect(await toi.toolSpace()).toBe(80_000);
  });

  it('apagar outra Conversa não interrompe o Fluxo em voo', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));
    await store.putConversation(makeConversation('c2'));

    const { provider, delta } = gatedProvider();
    const toi = await createToi({ ...deps, providers: providersOf(() => provider) });

    const pending = toi.flow.send(sendInput());
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

    const pending = toi.flow.send(sendInput());
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
      toi.flow.send(sendInput()),
    ).rejects.toMatchObject({ code: 'flow_busy' });

    store.release();
    await erasing;

    expect(await store.listMessages('c1')).toEqual([]);
    await expect(
      toi.flow.send(sendInput()),
    ).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('apagar Conversas recusa enquanto outra aba tem Fluxo em voo', async () => {
    const { store, credentials, deps } = await setup();
    await credentials.set('anthropic', 'sk-test');
    await store.putConversation(makeConversation('c1'));

    const { provider, delta } = gatedProvider();
    const tabA = await createToi({ ...deps, providers: providersOf(() => provider) });
    const tabB = await createToi(deps);

    const pending = tabA.flow.send(sendInput());
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
    expect(file).not.toContain('sk-secret');
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

    const pending = toi.flow.send(sendInput());
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

    const pending = toi.flow.send(sendInput());
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

  describe('Título gerado', () => {
    const haiku = makeModel('claude-haiku-5-5');

    /** Responde o chat com `answer` e o pedido do Título com `title`. */
    const titling = (answer: () => StreamEvent[], title = 'Pão de fermentação natural') => {
      const requests: ChatRequest[] = [];
      const provider: ChatProvider = {
        listModels: async () => [testModel, haiku],
        async *stream(request) {
          requests.push(request);
          yield* request.reasoning === 'on' ? answer() : replyEvents(title);
        },
      };
      return { provider, titleRequests: () => requests.filter((r) => r.reasoning === 'off') };
    };

    const connected = async (provider: ChatProvider) => {
      const { store, deps } = await setup();
      const toi = await createToi({ ...deps, providers: providersOf(() => provider) });
      await toi.connect('anthropic', 'sk-test');
      return { store, toi };
    };

    it('nomeia a Conversa quando a primeira resposta termina, com o Haiku sem raciocínio', async () => {
      const { provider, titleRequests } = titling(() => replyEvents('Você vai precisar de levain.'));
      const { store, toi } = await connected(provider);
      await store.putConversation(makeConversation('c1'));

      await toi.flow.send(sendInput({ text: 'como faço pão?' }));
      expect((await store.getConversation('c1'))?.title).toBe('como faço pão?');

      await vi.waitFor(async () =>
        expect(await store.getConversation('c1')).toMatchObject({
          title: 'Pão de fermentação natural',
          titleSource: 'generated',
        }),
      );
      expect(titleRequests()).toHaveLength(1);
      expect(titleRequests()[0]).toMatchObject({ model: haiku.id, reasoning: 'off', effort: 'low' });
    });

    it('só a primeira resposta conta: tentar de novo e o segundo envio não nomeiam', async () => {
      let fail = true;
      const { provider, titleRequests } = titling(() =>
        // Sem `finished`, o Fluxo fecha `failed`.
        fail ? replyEvents().slice(0, -1) : replyEvents(),
      );
      const { store, toi } = await connected(provider);
      await store.putConversation(makeConversation('c1'));
      await store.putConversation(makeConversation('c2'));

      const first = await toi.flow.send(sendInput());
      expect(first.message.status).toBe('failed');
      fail = false;
      await toi.flow.retry({ conversationId: 'c1', messageId: first.message.id, model: testModel, effort: 'low' });
      await toi.flow.send(sendInput({ text: 'e agora?' }));

      // A Conversa c2 serve de marco: quando ela foi nomeada, a c1 já teria pedido.
      await toi.flow.send(sendInput({ conversationId: 'c2' }));
      await vi.waitFor(async () =>
        expect((await store.getConversation('c2'))?.titleSource).toBe('generated'),
      );
      expect(titleRequests()).toHaveLength(1);
      expect((await store.getConversation('c1'))?.titleSource).toBe('derived');
    });

    it('renomear antes do primeiro envio mantém o nome da pessoa', async () => {
      const { provider } = titling(() => replyEvents());
      const { store, toi } = await connected(provider);
      await store.putConversation(makeConversation('c1'));

      await toi.renameConversation('c1', 'Meu pão');
      await toi.flow.send(sendInput());

      expect(await store.getConversation('c1')).toMatchObject({ title: 'Meu pão', titleSource: 'manual' });
    });
  });
});
