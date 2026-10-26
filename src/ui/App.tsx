import { Menu } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { RunResult } from '../app/send-message';
import type { Toi } from '../app/toi';
import type { AttachmentUpload } from '../domain/attachment';
import type { Conversation } from '../domain/conversation';
import type { ConversationId } from '../domain/ids';
import type { Message } from '../domain/message';
import {
  DEFAULT_EFFORT,
  defaultModel,
  findModel,
  pickedModels,
  refFrom,
  refOf,
  type Effort,
  type Model,
  type ModelPicks,
  type ModelRef,
} from '../domain/model';
import { Chat, type ChatHandle, type Notice, type NoticeAction } from './Chat';
import { Onboarding } from './Onboarding';
import type { ModelPicksError, ModelsState, SettingsSection } from './Settings';
import { Sidebar } from './Sidebar';
import { errorInfo, isTyping, lower, requestPersistence, selection } from './support';
import { followSystemTheme } from './theme';

/** Tela de bloqueio no lugar do Chat ou das Configurações: o motivo e o que resolve. */
const Blocked = ({ message, children }: { message: string; children: ReactNode }) => (
  <div className="flex flex-1 flex-col justify-center px-4 sm:px-8">
    <div className="mx-auto w-full max-w-[44rem]">
      <p className="text-base text-text">
        <span className="text-danger">*</span> {message}
      </p>
      <div className="mt-5 flex gap-6 text-base">{children}</div>
    </div>
  </div>
);

/** Chunk das Configurações que não baixou: a aba é anterior ao último deploy, que apagou o arquivo. */
const SettingsUnavailable = ({ onClose }: { onClose: () => void }) => (
  <Blocked message="as configurações não carregaram. o toi pode ter sido atualizado depois que esta aba abriu.">
    <button
      type="button"
      className="text-accent hover:underline"
      onClick={() => location.reload()}
    >
      recarregar
    </button>
    <button type="button" className="text-muted hover:text-accent" onClick={onClose}>
      voltar
    </button>
  </Blocked>
);

const Settings = lazy(() => import('./Settings').catch(() => ({ default: SettingsUnavailable })));

const noticeFrom = (result: RunResult): Notice | null => {
  if (result.persistError) return { kind: 'not_saved' };
  if (result.truncated) return { kind: 'truncated', truncation: result.truncated };
  return null;
};

/** "Apagar tudo" remonta a tela: a abertura relê o armazenamento vazio, sem refazer os padrões à mão. */
export const App = ({ toi }: { toi: Toi }) => {
  const [generation, setGeneration] = useState(0);
  return <Workspace key={generation} toi={toi} onErasedAll={() => setGeneration((n) => n + 1)} />;
};

const Workspace = ({ toi, onErasedAll }: { toi: Toi; onErasedAll: () => void }) => {
  // Um Provedor registrado por enquanto; a escolha entre vários entra com o segundo.
  const provider = toi.providers()[0]!;
  const [connected, setConnected] = useState(toi.connected());
  const [changingKey, setChangingKey] = useState(false);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // As escolhas gravadas que decidem o seletor; `failed` quando o armazenamento não as entrega.
  const [choices, setChoices] = useState<'loading' | 'ready' | 'failed'>('loading');
  // O cache de Modelos não se leu: é falha do armazenamento, não cache ausente.
  const [cacheFailed, setCacheFailed] = useState(false);
  const [models, setModels] = useState<ModelsState>({ list: [], stale: null, refreshing: true });
  const [lastModel, setLastModel] = useState<ModelRef | null>(null);
  const [lastEffort, setLastEffort] = useState<Effort | null>(null);
  const [modelPicks, setModelPicks] = useState<ModelPicks>(toi.defaultModelPicks);
  const [modelPicksError, setModelPicksError] = useState<ModelPicksError | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [selected, setSelected] = useState<ConversationId | null>(selection.read);
  // Conversas respondendo nesta aba; o Flow é a fonte, a tela só lê.
  const running = useSyncExternalStore(toi.flow.watch, toi.flow.active);
  // Um aviso por Conversa (`null` é o rascunho): o de um Fluxo que termina em segundo plano espera a
  // pessoa abrir a Conversa dele, nunca aparece na de outra.
  const [notices, setNotices] = useState<ReadonlyMap<ConversationId | null, Notice>>(new Map());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const chat = useRef<ChatHandle>(null);

  const conversation = conversations?.find((item) => item.id === selected) ?? null;
  const notice = notices.get(selected) ?? null;
  const responding = selected !== null && running.has(selected);

  const putNotice = useCallback((id: ConversationId | null, next: Notice | null) => {
    setNotices((current) => {
      if (next === null && !current.has(id)) return current;
      const updated = new Map(current);
      if (next === null) updated.delete(id);
      else updated.set(id, next);
      return updated;
    });
  }, []);

  useEffect(() => toi.watchConversations(setConversations), [toi]);
  useEffect(() => followSystemTheme(), []);
  useEffect(() => {
    // Espera todas assentarem: falhar antes de os Modelos do seletor chegarem abriria
    // Configurações com eles no padrão.
    void Promise.allSettled([
      toi.lastModel().then(setLastModel),
      toi.lastEffort().then(setLastEffort),
      // Os Modelos do seletor têm estado próprio de leitura falha, avisado em Configurações.
      toi.modelPicks().then(setModelPicks, (cause) =>
        setModelPicksError({ kind: 'read', error: errorInfo(cause) }),
      ),
    ]).then((reads) =>
      setChoices(reads.every((read) => read.status === 'fulfilled') ? 'ready' : 'failed'),
    );
  }, [toi]);

  // A abertura falha pelas escolhas ou pelo cache de Modelos, só depois de as escolhas assentarem.
  const opening =
    choices === 'loading' ? 'loading' : choices === 'failed' || cacheFailed ? 'failed' : 'ready';

  // Uma carga de Modelos por vez: a nova aborta a anterior, que não chega à tela.
  const modelsLoad = useRef<AbortController | null>(null);
  useEffect(() => () => modelsLoad.current?.abort(), []);

  const loadModels = useCallback(
    async (refresh: boolean) => {
      modelsLoad.current?.abort();
      const controller = new AbortController();
      modelsLoad.current = controller;
      setModels((current) => ({ ...current, refreshing: true }));

      let cached: Model[] | null = null;
      if (!refresh) {
        try {
          cached = await toi.models();
        } catch (cause) {
          if (controller.signal.aborted) return;
          // Sem cache a lista vem da API; com cache ilegível, a abertura para no bloqueio.
          setCacheFailed(true);
          setModels((current) => ({ ...current, stale: errorInfo(cause), refreshing: false }));
          return;
        }
      }
      if (controller.signal.aborted) return;
      if (cached) {
        setModels({ list: cached, stale: null, refreshing: false });
        return;
      }

      try {
        const list = await toi.refreshModels(controller.signal);
        if (controller.signal.aborted) return;
        setModels({ list, stale: null, refreshing: false });
      } catch (cause) {
        // Abortada, quem abortou já cuida da tela; não há erro a mostrar.
        if (controller.signal.aborted) return;
        // A lista anterior (o cache) segue valendo, marcada como desatualizada.
        const stale = errorInfo(cause);
        setModels((current) => ({ ...current, stale, refreshing: false }));
      }
    },
    [toi],
  );

  useEffect(() => {
    if (connected) void loadModels(false);
  }, [connected, loadModels]);

  const list = models.list;
  const options = useMemo(() => pickedModels(list, modelPicks), [list, modelPicks]);
  const model =
    findModel(list, refFrom(conversation)) ??
    defaultModel(options, lastModel);
  const effort = conversation ? conversation.effort : (lastEffort ?? DEFAULT_EFFORT);

  // Os handlers que descem ao Chat têm identidade estável, para o `memo` das Mensagens e dos
  // seletores acertar; o que leem do render vem daqui, atualizado a cada commit.
  const latest = useRef({ selected, conversation, model, effort });
  useLayoutEffect(() => {
    latest.current = { selected, conversation, model, effort };
  });

  // Sair de uma Conversa dispensa o aviso dela.
  const select = useCallback(
    (id: ConversationId | null) => {
      putNotice(latest.current.selected, null);
      setSelected(id);
      selection.write(id);
      setSidebarOpen(false);
      setSettings(null);
    },
    [putNotice],
  );

  // Seleção que não existe mais (apagada aqui ou em outra aba) vira rascunho.
  useEffect(() => {
    if (conversations !== null && selected !== null && !conversation) select(null);
  }, [conversations, selected, conversation, select]);

  // Otimista; se não grava, volta ao que está salvo e diz por quê.
  const changeModelPicks = async (picks: ModelPicks) => {
    const previous = modelPicks;
    setModelPicks(picks);
    try {
      await toi.saveModelPicks(picks);
      setModelPicksError(null);
    } catch (cause) {
      setModelPicks(previous);
      setModelPicksError({ kind: 'save', error: errorInfo(cause) });
    }
  };

  const changeModel = useCallback(
    (next: Model) => {
      setLastModel(refOf(next));
      const { conversation } = latest.current;
      if (conversation) void toi.changeModel(conversation.id, refOf(next));
    },
    [toi],
  );

  const changeEffort = useCallback(
    (next: Effort) => {
      setLastEffort(next);
      const { conversation } = latest.current;
      if (conversation) void toi.changeEffort(conversation.id, next);
    },
    [toi],
  );

  // O envio grava Modelo e Esforço como default da próxima Conversa; o rascunho já nasce com eles.
  const remember = useCallback((sent: Model, sentEffort: Effort) => {
    setLastModel(refOf(sent));
    setLastEffort(sentEffort);
  }, []);

  // O aviso vai para a Conversa do Fluxo, onde quer que a pessoa esteja quando ele termina.
  const run = useCallback(
    async (conversationId: ConversationId, start: () => Promise<RunResult>): Promise<boolean> => {
      putNotice(conversationId, null);

      try {
        putNotice(conversationId, noticeFrom(await start()));
        return true;
      } catch (cause) {
        const error = errorInfo(cause);
        if (error.code === 'not_connected') setConnected(false);
        putNotice(conversationId, { kind: 'error', error });
        return false;
      }
    },
    [putNotice],
  );

  // Para a Conversa à vista; as outras seguem respondendo.
  const stop = useCallback(() => {
    const { selected } = latest.current;
    if (selected !== null) void toi.flow.stop(selected);
  }, [toi]);

  const send = async (text: string, attachments: AttachmentUpload[]): Promise<boolean> => {
    if (!model) return false;

    let target = conversation;
    if (!target) {
      try {
        target = await toi.createConversation(refOf(model), effort);
      } catch (cause) {
        putNotice(selected, { kind: 'error', error: errorInfo(cause) });
        return false;
      }
      // Pedir cedo reduz a chance de o navegador descartar o histórico.
      void requestPersistence();
      const created = target;
      // Entra já na lista para a seleção não ser descartada antes de o watch entregar.
      setConversations((current) =>
        current?.some((item) => item.id === created.id) ? current : [created, ...(current ?? [])],
      );
      select(created.id);
    }

    const id = target.id;
    remember(model, effort);
    return run(id, () => toi.flow.send({ conversationId: id, text, attachments, model, effort }));
  };

  const retry = useCallback(
    (message: Message) => {
      const { model, effort } = latest.current;
      if (!model) return;
      remember(model, effort);
      void run(message.conversationId, () =>
        toi.flow.retry({
          conversationId: message.conversationId,
          messageId: message.id,
          model,
          effort,
        }),
      );
    },
    [toi, remember, run],
  );

  const manageModels = useCallback(() => setSettings('modelos'), []);
  const openSearchSettings = useCallback(() => setSettings('busca'), []);

  const remove = async (id: ConversationId) => {
    try {
      await toi.deleteConversation(id);
    } catch (cause) {
      putNotice(selected, { kind: 'error', error: errorInfo(cause) });
    }
  };

  const newConversation = useCallback(() => {
    select(null);
    requestAnimationFrame(() => chat.current?.focus());
  }, [select]);

  /** Ação que resolve o erro, quando existe uma na tela: rótulo e efeito no mesmo lugar. */
  const noticeAction = (current: Notice | null): NoticeAction | null => {
    if (current?.kind !== 'error') return null;
    switch (current.error.code) {
      case 'invalid_credential':
      case 'not_connected':
        return { label: 'trocar chave', run: () => setChangingKey(true) };
      case 'model_unavailable':
        return {
          label: 'atualizar modelos',
          run: () => {
            putNotice(selected, null);
            void loadModels(true);
          },
        };
      case 'context_overflow':
      case 'request_too_large':
      case 'attachment_rejected':
        return { label: 'nova conversa', run: newConversation };
      default:
        return null;
    }
  };

  // Atalhos de uma tecla, como no blog: só fora de campos de texto.
  useEffect(() => {
    if (!connected || changingKey) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (responding) stop();
        else if (settings) setSettings(null);
        else if (sidebarOpen) setSidebarOpen(false);
        return;
      }
      if (isTyping(event)) return;

      if (event.key === '/') {
        event.preventDefault();
        setSettings(null);
        requestAnimationFrame(() => chat.current?.focus());
      } else if (event.key === 'n') {
        event.preventDefault();
        newConversation();
      } else if (event.key === 'c') {
        event.preventDefault();
        setSettings((open) => (open ? null : 'top'));
        setSidebarOpen(false);
      }
    };

    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, [connected, changingKey, responding, stop, settings, sidebarOpen, newConversation]);

  if (!connected || changingKey) {
    return (
      <Onboarding
        toi={toi}
        provider={provider}
        onCancel={connected ? () => setChangingKey(false) : undefined}
        onConnected={(fresh) => {
          // A lista da Chave nova vale; uma atualização pela anterior não chega à tela.
          modelsLoad.current?.abort();
          setModels({ list: fresh, stale: null, refreshing: false });
          setConnected(true);
          setChangingKey(false);
          setNotices(new Map());
        }}
      />
    );
  }

  // Até ler as escolhas e ter uma lista de Modelos (o cache ou, sem ele, a da API), só a casca: o
  // seletor nasceria no padrão e trocaria, e o bloqueio de "nenhum modelo marcado" piscaria.
  const loading = opening === 'loading' || (models.refreshing && list.length === 0);

  const blocker =
    list.length > 0
      ? null
      : models.stale
        ? lower(models.stale.message)
        : 'nenhum modelo disponível para esta chave.';

  return (
    <div className="grid h-dvh grid-cols-1 md:grid-cols-[18rem_1fr]">
      <Sidebar
        conversations={conversations ?? []}
        selected={selected}
        running={running}
        settingsOpen={settings !== null}
        open={sidebarOpen}
        now={Date.now()}
        onNew={newConversation}
        onSelect={select}
        onRename={(id, title) => void toi.renameConversation(id, title)}
        onDelete={(id) => void remove(id)}
        onSettings={() => {
          setSettings('top');
          setSidebarOpen(false);
        }}
      />
      {sidebarOpen && (
        <button
          type="button"
          aria-label="fechar conversas"
          className="fixed inset-0 z-10 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-col">
        {/* Configurações esperam as escolhas gravadas, ou mostrariam as do padrão. Com a abertura
            falha também abrem: dali dá para trocar a Chave ou apagar tudo. */}
        {settings && opening !== 'loading' ? (
          <Suspense fallback={<div className="flex-1" />}>
            <Settings
              toi={toi}
              provider={provider}
              models={models}
              modelPicks={modelPicks}
              picked={options}
              modelPicksError={modelPicksError}
              section={settings}
              onModelPicksChange={(picks) => void changeModelPicks(picks)}
              conversationCount={conversations?.length ?? 0}
              onRefreshModels={() => void loadModels(true)}
              onChangeKey={() => setChangingKey(true)}
              onKeyRemoved={() => setConnected(false)}
              onErasedAll={() => {
                // A tela remontada nasce no rascunho, sem a Conversa apagada.
                selection.write(null);
                onErasedAll();
              }}
              onClose={() => setSettings(null)}
            />
          </Suspense>
        ) : (
          <>
            {/* No desktop a sidebar já mostra a Conversa ativa; o título fica só para leitor de tela. */}
            <header className="flex items-center gap-3 px-4 py-3 sm:px-8 md:sr-only">
              <button
                type="button"
                aria-label="abrir conversas"
                aria-expanded={sidebarOpen}
                className="-ml-1 p-1 text-muted hover:text-accent md:hidden"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu size={18} aria-hidden />
              </button>
              <h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-semibold text-text">
                <span className="text-accent" aria-hidden="true">
                  *
                </span>
                <span className="truncate">
                  {(conversation?.title ?? 'nova conversa').toLowerCase()}
                </span>
              </h1>
            </header>

            {opening === 'failed' ? (
              <Blocked message="não deu para ler as configurações salvas neste navegador.">
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => location.reload()}
                >
                  recarregar
                </button>
                <button
                  type="button"
                  className="text-muted hover:text-accent"
                  onClick={() => setSettings('top')}
                >
                  abrir configurações
                </button>
              </Blocked>
            ) : loading ? (
              <div className="flex-1" />
            ) : blocker ? (
              <Blocked message={blocker}>
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => void loadModels(true)}
                >
                  tentar de novo
                </button>
                <button
                  type="button"
                  className="text-muted hover:text-accent"
                  onClick={() => setChangingKey(true)}
                >
                  trocar chave
                </button>
              </Blocked>
            ) : !model ? (
              <Blocked message="nenhum modelo marcado existe para esta chave.">
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={manageModels}
                >
                  escolher modelos
                </button>
              </Blocked>
            ) : (
              <Chat
                ref={chat}
                toi={toi}
                provider={provider}
                conversationId={selected}
                models={list}
                modelOptions={options}
                model={model}
                effort={effort}
                running={responding}
                notice={notice}
                noticeAction={noticeAction(notice)}
                onModelChange={changeModel}
                onEffortChange={changeEffort}
                onManageModels={manageModels}
                onSend={send}
                onStop={stop}
                onRetry={retry}
                onDismissNotice={() => putNotice(selected, null)}
                onOpenSearchSettings={openSearchSettings}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
};
