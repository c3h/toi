import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { createToi } from '../../src/app/toi';
import { tinyfishInfo } from '../../src/adapters/services/tinyfish/info';
import { appError } from '../../src/domain/error';
import type { ProviderId } from '../../src/domain/ids';
import { refOf, type Model } from '../../src/domain/model';
import type { ChatProvider } from '../../src/ports/chat-provider';
import { App } from '../../src/ui/App';
import type { StreamEvent } from '../../src/domain/stream';
import { WEB_SEARCH } from '../../src/domain/web';
import {
  deferred,
  FailingProvider,
  FakeWebTools,
  gatedProvider,
  hit,
  makeModel,
  MemoryCredentialStore,
  MemoryLocks,
  MemorySettingsStore,
  MemoryStore,
  providersOf,
  replyEvents,
  ScriptedProvider,
  round,
  testModel,
  textEvents,
  toolCall,
  UnreadableInstructions,
  untilAborted,
  usage,
} from '../helpers';

interface MountOptions {
  store?: MemoryStore;
  /** A Chave do Serviço já está gravada e as Ferramentas respondem por ele. */
  tools?: FakeWebTools;
  settings?: MemorySettingsStore;
  /** A Chave do Provedor já está gravada: o App abre conectado, sem onboarding. */
  connected?: boolean;
}

const mount = async (
  createProvider: (key: string) => ChatProvider,
  {
    store = new MemoryStore(),
    tools,
    settings = new MemorySettingsStore(),
    connected = false,
  }: MountOptions = {},
) => {
  sessionStorage.clear();
  let next = 0;
  const credentials = new MemoryCredentialStore();
  if (tools) await credentials.set('tinyfish', 'tf-test');
  if (connected) await credentials.set('anthropic', 'sk-test');
  const toi = await createToi({
    store,
    credentials,
    settings,
    clock: { now: () => Date.now() },
    estimator: { estimate: () => 1, estimateAttachment: () => 1 },
    newId: () => `id-${(next += 1)}`,
    locks: new MemoryLocks(),
    providers: providersOf(createProvider),
    service: { info: tinyfishInfo, create: () => tools ?? new FakeWebTools() },
    locale: 'pt-BR',
  });
  return render(<App toi={toi} />);
};

const connect = async (screen: Awaited<ReturnType<typeof render>>, key = 'sk-test') => {
  await userEvent.fill(screen.getByLabelText('chave da api'), key);
  await userEvent.click(screen.getByRole('button', { name: 'conectar' }));
};

/** Guarda o `signal` de cada listagem: a primeira volta na hora; as seguintes, só abortadas. */
class HangingRefresh extends ScriptedProvider {
  readonly signals: AbortSignal[] = [];

  override async listModels(signal: AbortSignal): Promise<Model[]> {
    this.signals.push(signal);
    if (this.signals.length > 1) await untilAborted(signal);
    return super.listModels(signal);
  }
}

type SettingsRead = 'lastModel' | 'lastEffort' | 'models';

/** Uma leitura das Configurações rejeita como o IndexedDB que caiu, até "apagar tudo" as limpar. */
class FailingSettings extends MemorySettingsStore {
  #failing: SettingsRead | null;

  constructor(failing: SettingsRead) {
    super();
    this.#failing = failing;
  }

  #check(read: SettingsRead): void {
    if (read === this.#failing) {
      throw new DOMException('Connection to Indexed Database server lost.', 'UnknownError');
    }
  }

  override async lastModel() {
    this.#check('lastModel');
    return super.lastModel();
  }

  override async lastEffort() {
    this.#check('lastEffort');
    return super.lastEffort();
  }

  override async models(provider: ProviderId) {
    this.#check('models');
    return super.models(provider);
  }

  override async clear() {
    this.#failing = null;
    return super.clear();
  }
}

const openSettings = async (screen: Awaited<ReturnType<typeof render>>) => {
  await connect(screen);
  await userEvent.click(screen.getByRole('button', { name: /configurações/ }));
};

describe('App', () => {
  it('mostra o erro tipado e não sai do onboarding com Chave inválida', async () => {
    const screen = await mount(() => new FailingProvider([]));
    await connect(screen, 'sk-ruim');

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('chave inválida ou revogada.');
    await expect.element(screen.getByLabelText('chave da api')).toBeVisible();
  });

  it('conecta, envia e mostra a resposta com o uso', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents('**Olá**, tudo certo.')));
    await connect(screen);

    await userEvent.fill(screen.getByLabelText('mensagem'), 'Primeira pergunta');
    await userEvent.keyboard('{Enter}');

    await expect.element(screen.getByText('Primeira pergunta', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Olá')).toBeVisible();
    await expect.element(screen.getByTitle('10 tokens de entrada, 5 de saída')).toBeVisible();
    await expect.element(screen.getByTitle(/até o modelo responder$/)).toBeVisible();
    await expect
      .element(screen.getByRole('button', { name: 'primeira pergunta', exact: true }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('o rodapé diz quanto da entrada veio do cache', async () => {
    const cached = { cacheCreationInputTokens: 20, cacheReadInputTokens: 1200 };
    const screen = await mount(
      () =>
        new ScriptedProvider([
          { type: 'started', model: testModel.id, usage: { ...usage(10, 0), ...cached } },
          ...textEvents('Olá'),
          { type: 'usage', usage: { ...usage(10, 5), ...cached }, stopReason: 'end_turn' },
          { type: 'finished' },
        ]),
    );
    await connect(screen);

    await userEvent.fill(screen.getByLabelText('mensagem'), 'Pergunta');
    await userEvent.keyboard('{Enter}');

    await expect
      .element(screen.getByTitle('1.230 tokens de entrada (1.200 do cache), 5 de saída'))
      .toHaveTextContent('1.230 → 5');
  });

  it('mostra a Busca na resposta e abre as Fontes', async () => {
    const tools = new FakeWebTools();
    tools.searchAnswer = { hits: [hit('https://www.exemplo.com/cobre', 'Cobre hoje')] };
    const provider = new ScriptedProvider({
      rounds: [
        round(toolCall(0, 't1', WEB_SEARCH, '{"query":"cobre"}'), 'tool_use', 3),
        replyEvents('O cobre subiu.'),
      ],
    });
    const screen = await mount(() => provider, { tools });
    await connect(screen);

    await userEvent.fill(screen.getByLabelText('mensagem'), 'Cobre hoje?');
    await userEvent.keyboard('{Enter}');

    await expect.element(screen.getByText('O cobre subiu.')).toBeVisible();
    const row = screen.getByRole('button', { name: /buscou “cobre”.*1 fonte/ });
    await expect.element(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(row);
    await expect
      .element(screen.getByRole('link', { name: /exemplo\.com.*Cobre hoje/ }))
      .toHaveAttribute('href', 'https://www.exemplo.com/cobre');
  });

  it('o espaço da busca começa no padrão e guarda a escolha', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()), {
      tools: new FakeWebTools(),
    });
    await openSettings(screen);

    const group = screen.getByRole('group', { name: 'espaço por resposta' });
    await expect.element(group.getByRole('radio', { name: /40 mil · padrão/ })).toBeChecked();

    await userEvent.click(group.getByRole('radio', { name: /80 mil/ }));

    await expect.element(group.getByRole('radio', { name: /80 mil/ })).toBeChecked();
  });

  it('revela a resposta aos poucos e só fecha o rodapé com ela inteira', async () => {
    const reply = Array.from({ length: 60 }, (_, index) => `palavra${index}`).join(' ');
    // O Fluxo só fecha depois que a tela viu a resposta em `streaming`.
    const { promise: streamed, resolve: finish } = deferred();
    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      for (const event of replyEvents(reply)) {
        if (event.type === 'finished') await streamed;
        yield event;
      }
    });
    const screen = await mount(() => provider);
    await connect(screen);
    await userEvent.fill(screen.getByLabelText('mensagem'), 'Pergunta');
    await userEvent.keyboard('{Enter}');

    // Um retrato por frame até o rodapé aparecer.
    const frames = await new Promise<Array<{ text: string; footer: boolean }>>((resolve) => {
      const seen: Array<{ text: string; footer: boolean }> = [];
      const sample = () => {
        const answer = screen.container.querySelectorAll('article')[1];
        const footer = answer?.querySelector('[title$="de saída"]') != null;
        const text = answer?.querySelector('.prose-reply')?.textContent ?? '';
        seen.push({ text, footer });
        if (text !== '') finish();
        if (footer) resolve(seen);
        else requestAnimationFrame(sample);
      };
      sample();
    });

    expect(frames.some(({ text }) => text !== '' && text !== reply)).toBe(true);
    expect(frames.filter(({ footer }) => footer).map(({ text }) => text)).toEqual([reply]);
  });

  it('esc para o Fluxo, preserva o texto e oferece tentar de novo', async () => {
    const { provider, delta } = gatedProvider();
    const screen = await mount(() => provider);
    await connect(screen);

    await userEvent.fill(screen.getByLabelText('mensagem'), 'Pergunta longa');
    await userEvent.keyboard('{Enter}');
    await delta;
    await expect.element(screen.getByRole('button', { name: /parar/ })).toBeVisible();

    await userEvent.keyboard('{Escape}');

    await expect.element(screen.getByText('resposta interrompida.')).toBeVisible();
    await expect.element(screen.getByText('a', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'tentar de novo' })).toBeVisible();
  });

  it('shift+enter quebra linha sem enviar', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()));
    await connect(screen);

    const input = screen.getByLabelText('mensagem');
    await userEvent.click(input);
    await userEvent.keyboard('linha 1{Shift>}{Enter}{/Shift}linha 2');

    await expect.element(input).toHaveValue('linha 1\nlinha 2');
    expect(screen.container.querySelector('article')).toBeNull();
  });

  it('apagar uma Conversa sai do menu da linha e pede confirmação', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()));
    await connect(screen);
    await userEvent.fill(screen.getByLabelText('mensagem'), 'Para apagar');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByText('Olá')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'ações de para apagar' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'apagar' }));
    await userEvent.click(screen.getByRole('button', { name: 'sim, apagar' }));

    await expect.element(screen.getByText('suas conversas aparecem aqui.')).toBeVisible();
  });

  it('o seletor oferece só os Modelos marcados em Configurações', async () => {
    const model = (id: string, displayName: string, createdAt: string): Model =>
      makeModel(id, { displayName, createdAt });
    const models = [
      model('claude-opus-5-5', 'Claude Opus 5.5', '2026-09-02'),
      model('claude-sonnet-5-5', 'Claude Sonnet 5.5', '2026-09-01'),
      model('claude-haiku-5-5', 'Claude Haiku 5.5', '2026-08-01'),
      model('claude-sonnet-5', 'Claude Sonnet 5', '2026-05-01'),
    ];
    const screen = await mount(() => new ScriptedProvider(replyEvents(), models));
    await connect(screen);

    await userEvent.click(screen.getByRole('button', { name: /^modelo:/ }));
    const options = screen.getByRole('menuitemradio');
    await expect.element(options.first()).toBeVisible();
    expect(options.elements().map((item) => item.textContent)).toEqual([
      'claude sonnet 5.5',
      'claude haiku 5.5',
    ]);

    await userEvent.click(screen.getByRole('menuitem', { name: 'escolher modelos' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /claude opus 5\.5/ }));
    await userEvent.click(screen.getByRole('button', { name: /voltar/ }));

    await userEvent.click(screen.getByRole('button', { name: /^modelo:/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'claude opus 5.5' }));
    await expect
      .element(screen.getByRole('button', { name: 'modelo: claude opus 5.5' }))
      .toBeVisible();
  });

  it('trocar a Chave aborta a atualização da lista pela anterior, sem erro na tela', async () => {
    // Conectar lista na hora; a atualização em Configurações fica pendurada até ser abortada.
    const previous = new HangingRefresh(replyEvents());
    const sonnet = makeModel('claude-sonnet-5-5', { displayName: 'Claude Sonnet 5.5' });
    const screen = await mount((key) =>
      key === 'sk-test' ? previous : new ScriptedProvider(replyEvents(), [sonnet]),
    );
    await connect(screen);

    await userEvent.click(screen.getByRole('button', { name: /configurações/ }));
    await userEvent.click(screen.getByRole('button', { name: 'atualizar lista' }));
    await expect.element(screen.getByRole('button', { name: 'atualizando…' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'trocar chave' }));
    await connect(screen, 'sk-nova');

    await expect.element(screen.getByRole('button', { name: 'atualizar lista' })).toBeEnabled();
    expect(previous.signals[1]?.aborted).toBe(true);
    expect(screen.container.textContent).not.toContain('desatualizada');
  });

  it('entrar em trocar chave e manter a atual deixa a atualização da lista terminar', async () => {
    const listed = deferred();
    class GatedListing extends ScriptedProvider {
      calls = 0;

      override async listModels(signal: AbortSignal): Promise<Model[]> {
        this.calls += 1;
        // Conectar lista na hora; a atualização em Configurações espera o teste soltar.
        if (this.calls > 1) await listed.promise;
        return super.listModels(signal);
      }
    }
    const screen = await mount(() => new GatedListing(replyEvents()));
    await connect(screen);

    await userEvent.click(screen.getByRole('button', { name: /configurações/ }));
    await userEvent.click(screen.getByRole('button', { name: 'atualizar lista' }));
    await expect.element(screen.getByRole('button', { name: 'atualizando…' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'trocar chave' }));
    await userEvent.click(screen.getByRole('button', { name: /manter a chave atual/ }));
    listed.resolve();

    await expect.element(screen.getByRole('button', { name: 'atualizar lista' })).toBeEnabled();
    expect(screen.container.textContent).not.toContain('desatualizada');
  });

  it('começa no menor Esforço, envia o escolhido e a Conversa nova herda o do último envio', async () => {
    const provider = new ScriptedProvider(replyEvents());
    const screen = await mount(() => provider);
    await connect(screen);

    await expect.element(screen.getByRole('button', { name: 'esforço: baixo' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^esforço:/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'muito alto' }));

    await userEvent.fill(screen.getByLabelText('mensagem'), 'Pergunta');
    await userEvent.keyboard('{Enter}');

    await expect.element(screen.getByTitle('esforço muito alto')).toBeVisible();
    expect(provider.requests[0]?.effort).toBe('xhigh');

    await userEvent.click(screen.getByRole('button', { name: 'nova conversa' }));
    await expect.element(screen.getByRole('button', { name: 'esforço: muito alto' })).toBeVisible();
  });

  it('sem nenhum Modelo marcado para a Chave, diz isso e leva à escolha', async () => {
    const opus = makeModel('claude-opus-5-5', { displayName: 'Claude Opus 5.5' });
    const screen = await mount(() => new ScriptedProvider(replyEvents(), [opus]));
    await connect(screen);

    await expect
      .element(screen.getByText('nenhum modelo marcado existe para esta chave.'))
      .toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'escolher modelos' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /claude opus 5\.5/ }));
    await userEvent.click(screen.getByRole('button', { name: /voltar/ }));

    await expect
      .element(screen.getByRole('button', { name: 'modelo: claude opus 5.5' }))
      .toBeVisible();
  });

  it('abre sem piscar: o seletor só aparece com o cache de Modelos e as escolhas lidos', async () => {
    const sonnet = makeModel('claude-sonnet-5-5', {
      displayName: 'Claude Sonnet 5.5',
      createdAt: '2026-09-01',
    });
    const haiku = makeModel('claude-haiku-5-5', {
      displayName: 'Claude Haiku 5.5',
      createdAt: '2026-08-01',
    });
    const cache = deferred();
    const saved = deferred();
    class SlowSettings extends MemorySettingsStore {
      override async models(provider: ProviderId): Promise<Model[] | null> {
        await cache.promise;
        return super.models(provider);
      }

      override async lastModel() {
        await saved.promise;
        return super.lastModel();
      }
    }
    const settings = new SlowSettings();
    await settings.saveModels('anthropic', [sonnet, haiku]);
    await settings.saveLastModel(refOf(haiku));

    // Cada estado que a tela mostra, na ordem: a casca, o bloqueio ou o seletor.
    const shown: string[] = [];
    const observer = new MutationObserver(() => {
      const picker = document.querySelector('[aria-label^="modelo:"]');
      const state = document.body.textContent.includes('nenhum modelo')
        ? 'bloqueio'
        : (picker?.getAttribute('aria-label') ?? 'casca');
      if (shown.at(-1) !== state) shown.push(state);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });

    const screen = await mount(() => new ScriptedProvider(replyEvents(), [sonnet, haiku]), {
      settings,
      connected: true,
    });
    await expect.element(screen.getByRole('button', { name: /nova conversa/ })).toBeVisible();
    cache.resolve();
    // Um frame para a tela mostrar o que tiver com a lista e sem o último Modelo.
    await new Promise(requestAnimationFrame);
    saved.resolve();

    await expect
      .element(screen.getByRole('button', { name: 'modelo: claude haiku 5.5' }))
      .toBeVisible();
    observer.disconnect();
    expect(shown).toEqual(['casca', 'modelo: claude haiku 5.5']);
  });

  it('sem conseguir ler as escolhas gravadas, diz isso e oferece recarregar', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()), {
      settings: new FailingSettings('lastEffort'),
      connected: true,
    });

    await expect
      .element(screen.getByText('não deu para ler as configurações salvas neste navegador.'))
      .toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'recarregar' })).toBeVisible();
    expect(screen.container.querySelector('[aria-label^="modelo:"]')).toBeNull();
  });

  it('sem conseguir ler o último Modelo, Configurações abrem e apagar tudo recomeça', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()), {
      settings: new FailingSettings('lastModel'),
      connected: true,
    });

    await userEvent.click(screen.getByRole('button', { name: 'abrir configurações' }));
    await expect.element(screen.getByRole('button', { name: 'trocar chave' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'apagar tudo' }));
    await userEvent.click(screen.getByRole('button', { name: 'sim, continuar' }));

    // A tela remonta e relê o armazenamento vazio: a abertura que falhou não volta.
    await connect(screen);
    await expect.element(screen.getByRole('button', { name: 'modelo: claude test' })).toBeVisible();
  });

  it('sem conseguir ler o cache de Modelos, bloqueia a abertura em vez de listar na API', async () => {
    const provider = new HangingRefresh(replyEvents());
    const screen = await mount(() => provider, {
      settings: new FailingSettings('models'),
      connected: true,
    });

    await expect
      .element(screen.getByText('não deu para ler as configurações salvas neste navegador.'))
      .toBeVisible();
    expect(provider.signals).toHaveLength(0);
  });

  it('sem cache de Modelos, a abertura lista na API', async () => {
    const provider = new HangingRefresh(replyEvents());
    const screen = await mount(() => provider, { connected: true });

    await expect.element(screen.getByRole('button', { name: 'modelo: claude test' })).toBeVisible();
    expect(provider.signals).toHaveLength(1);
  });
});

type Screen = Awaited<ReturnType<typeof render>>;

const filePicker = (screen: Screen): HTMLInputElement =>
  screen.container.querySelector<HTMLInputElement>('input[type="file"]')!;

const pngFile = async (name: string): Promise<File> => {
  const canvas = new OffscreenCanvas(30, 20);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#c60';
  context.fillRect(0, 0, 30, 20);
  return new File([await canvas.convertToBlob({ type: 'image/png' })], name);
};

describe('App: Instruções', () => {
  it('salva as Instruções, que vão no envio seguinte', async () => {
    const provider = new ScriptedProvider(replyEvents());
    const screen = await mount(() => provider);
    await openSettings(screen);

    const field = screen.getByLabelText('instruções');
    await expect.element(field).toBeEnabled();
    await userEvent.fill(field, '  responda curto  ');
    await expect.element(screen.getByText('não salvo')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'salvar' }));
    await expect.element(screen.getByText('salvo.')).toBeVisible();
    await expect.element(field).toHaveValue('responda curto');

    await userEvent.click(screen.getByRole('button', { name: /voltar/ }));
    await userEvent.fill(screen.getByLabelText('mensagem'), 'Pergunta');
    await userEvent.keyboard('{Enter}');

    await expect.element(screen.getByText('Olá')).toBeVisible();
    expect(provider.requests[0]!.system).toBe('responda curto');
  });

  it('com texto não salvo, esc sai do campo sem fechar; acima do teto não salva', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()));
    await openSettings(screen);

    const field = screen.getByLabelText('instruções');
    await userEvent.fill(field, 'rascunho');
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('heading', { name: 'configurações' })).toBeVisible();
    await expect.element(field).toHaveValue('rascunho');

    await userEvent.fill(field, 'x'.repeat(4_001));
    await expect.element(screen.getByText('4.001 de 4.000 caracteres')).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'salvar' })).toBeDisabled();
  });

  it('sem ler as gravadas, não abre o campo', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()), {
      settings: new UnreadableInstructions(),
    });
    await openSettings(screen);

    await expect
      .element(screen.getByText(/não deu para ler as instruções salvas/))
      .toBeVisible();
    expect(screen.getByLabelText('instruções').query()).toBeNull();
  });

  it('gravar que falha mantém o rascunho', async () => {
    class FailingSave extends MemorySettingsStore {
      override async saveInstructions(): Promise<void> {
        throw new Error('cheio');
      }
    }
    const screen = await mount(() => new ScriptedProvider(replyEvents()), {
      settings: new FailingSave(),
    });
    await openSettings(screen);

    const field = screen.getByLabelText('instruções');
    await userEvent.fill(field, 'responda curto');
    await userEvent.click(screen.getByRole('button', { name: 'salvar' }));

    await expect.element(screen.getByRole('alert')).toHaveTextContent('algo deu errado.');
    await expect.element(field).toHaveValue('responda curto');
    await expect.element(screen.getByText('não salvo')).toBeVisible();
  });
});

describe('App: Anexos', () => {
  it('anexa pelo clipe, colando e soltando, e envia sem texto', async () => {
    const provider = new ScriptedProvider(replyEvents());
    const screen = await mount(() => provider);
    await connect(screen);
    const field = screen.getByLabelText('mensagem').element();

    await userEvent.upload(filePicker(screen), new File(['# notas'], 'notas.md'));
    const pasted = new DataTransfer();
    pasted.items.add(await pngFile('tela.png'));
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true }));
    const dropped = new DataTransfer();
    dropped.items.add(new File(['a,b'], 'tabela.csv'));
    field.dispatchEvent(new DragEvent('drop', { dataTransfer: dropped, bubbles: true }));

    await expect.element(screen.getByText('30×20 · 1 kb')).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'enviar' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'enviar' }));

    await expect.element(screen.getByText('Olá')).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'baixar notas.md' })).toBeVisible();
    expect(provider.requests[0]?.messages[0]?.parts).toMatchObject([
      { type: 'file', attachment: { kind: 'text', name: 'notas.md' } },
      { type: 'file', attachment: { kind: 'image', mediaType: 'image/png' } },
      { type: 'file', attachment: { kind: 'text', name: 'tabela.csv' } },
    ]);
    await expect
      .element(screen.getByRole('button', { name: 'notas.md', exact: true }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('um arquivo recusado bloqueia o envio até sair do rascunho', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()));
    await connect(screen);

    await userEvent.fill(screen.getByLabelText('mensagem'), 'veja');
    await userEvent.upload(filePicker(screen), new File([new Uint8Array([0, 1, 2])], 'x.bin'));

    await expect.element(screen.getByText('só imagem, pdf ou texto em utf-8')).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'enviar' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'remover x.bin' }));
    await expect.element(screen.getByRole('button', { name: 'enviar' })).toBeEnabled();
  });

  it('sem espaço no navegador, o texto e os anexos voltam ao composer', async () => {
    class FullStore extends MemoryStore {
      override async startTurn(): Promise<never> {
        throw appError('storage_full');
      }
    }
    const screen = await mount(() => new ScriptedProvider(replyEvents()), {
      store: new FullStore(),
    });
    await connect(screen);

    await userEvent.upload(filePicker(screen), new File(['abc'], 'dados.csv'));
    await expect.element(screen.getByText('1 kb')).toBeVisible();
    await userEvent.fill(screen.getByLabelText('mensagem'), 'resuma');
    await userEvent.keyboard('{Enter}');

    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent('o navegador ficou sem espaço para salvar esta Mensagem.');
    await expect.element(screen.getByLabelText('mensagem')).toHaveValue('resuma');
    await expect.element(screen.getByRole('button', { name: 'remover dados.csv' })).toBeVisible();
  });
});
