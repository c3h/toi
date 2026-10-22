import { Menu } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

const Settings = lazy(() => import('./Settings'));

/** Tela no lugar do Chat quando não há Modelo para conversar: o motivo e o que resolve. */
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

const noticeFrom = (result: RunResult): Notice | null => {
  if (result.persistError) return { kind: 'not_saved' };
  if (result.truncated) return { kind: 'truncated', truncation: result.truncated };
  return null;
};

export const App = ({ toi }: { toi: Toi }) => {
  // Um Provedor registrado por enquanto; a escolha entre vários entra com o segundo.
  const provider = toi.providers()[0]!;
  const [connected, setConnected] = useState(toi.connected());
  const [changingKey, setChangingKey] = useState(false);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [models, setModels] = useState<ModelsState>({ list: [], stale: null, refreshing: true });
  const [lastModel, setLastModel] = useState<ModelRef | null>(null);
  const [lastEffort, setLastEffort] = useState<Effort | null>(null);
  const [modelPicks, setModelPicks] = useState<ModelPicks>(toi.defaultModelPicks);
  const [modelPicksError, setModelPicksError] = useState<ModelPicksError | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [selected, setSelected] = useState<ConversationId | null>(selection.read);
  const [running, setRunning] = useState<ConversationId | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const chat = useRef<ChatHandle>(null);

  const conversation = conversations?.find((item) => item.id === selected) ?? null;

  useEffect(() => toi.watchConversations(setConversations), [toi]);
  useEffect(() => followSystemTheme(), []);
  useEffect(() => {
    void toi.lastModel().then(setLastModel);
    void toi.lastEffort().then(setLastEffort);
    void toi.modelPicks().then(setModelPicks, (cause) =>
      setModelPicksError({ kind: 'read', error: errorInfo(cause) }),
    );
  }, [toi]);

  const loadModels = useCallback(
    async (refresh: boolean) => {
      setModels((current) => ({ ...current, refreshing: true }));

      const cached = refresh ? null : await toi.models().catch(() => null);
      if (cached) {
        setModels({ list: cached, stale: null, refreshing: false });
        return;
      }

      try {
        setModels({ list: await toi.refreshModels(), stale: null, refreshing: false });
      } catch (cause) {
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

  const select = useCallback((id: ConversationId | null) => {
    setSelected(id);
    selection.write(id);
    setNotice(null);
    setSidebarOpen(false);
    setSettings(null);
  }, []);

  // Seleção que não existe mais (apagada aqui ou em outra aba) vira rascunho.
  useEffect(() => {
    if (conversations !== null && selected !== null && !conversation) select(null);
  }, [conversations, selected, conversation, select]);

  const list = models.list;
  const options = pickedModels(list, modelPicks);
  const model =
    findModel(list, refFrom(conversation)) ??
    defaultModel(options, lastModel);
  const effort = conversation ? conversation.effort : (lastEffort ?? DEFAULT_EFFORT);

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

  const changeModel = async (next: Model) => {
    setLastModel(refOf(next));
    if (conversation) await toi.changeModel(conversation.id, refOf(next));
  };

  const changeEffort = async (next: Effort) => {
    setLastEffort(next);
    if (conversation) await toi.changeEffort(conversation.id, next);
  };

  // O envio grava Modelo e Esforço como default da próxima Conversa; o rascunho já nasce com eles.
  const remember = (sent: Model, sentEffort: Effort) => {
    setLastModel(refOf(sent));
    setLastEffort(sentEffort);
  };

  const run = async (
    conversationId: ConversationId,
    start: () => Promise<RunResult>,
  ): Promise<boolean> => {
    setRunning(conversationId);
    setNotice(null);

    try {
      setNotice(noticeFrom(await start()));
      return true;
    } catch (cause) {
      const error = errorInfo(cause);
      if (error.code === 'not_connected') setConnected(false);
      setNotice({ kind: 'error', error });
      return false;
    } finally {
      setRunning(null);
    }
  };

  const send = async (text: string, attachments: AttachmentUpload[]): Promise<boolean> => {
    if (!model) return false;

    let target = conversation;
    if (!target) {
      try {
        target = await toi.createConversation(refOf(model), effort);
      } catch (cause) {
        setNotice({ kind: 'error', error: errorInfo(cause) });
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

  const retry = (message: Message) => {
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
  };

  const remove = async (id: ConversationId) => {
    try {
      await toi.deleteConversation(id);
    } catch (cause) {
      setNotice({ kind: 'error', error: errorInfo(cause) });
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
            setNotice(null);
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
        if (running) void toi.flow.stop();
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
  }, [toi, connected, changingKey, running, settings, sidebarOpen, newConversation]);

  if (!connected || changingKey) {
    return (
      <Onboarding
        toi={toi}
        provider={provider}
        onCancel={connected ? () => setChangingKey(false) : undefined}
        onConnected={(fresh) => {
          setModels({ list: fresh, stale: null, refreshing: false });
          setConnected(true);
          setChangingKey(false);
          setNotice(null);
        }}
      />
    );
  }

  const blocker =
    models.refreshing || list.length > 0
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
        {settings ? (
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
                select(null);
                setLastModel(null);
                setLastEffort(null);
                setModelPicks(toi.defaultModelPicks());
                setModelPicksError(null);
                setConnected(false);
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

            {blocker ? (
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
                  onClick={() => setSettings('modelos')}
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
                running={running !== null}
                notice={notice}
                noticeAction={noticeAction(notice)}
                onModelChange={(next) => void changeModel(next)}
                onEffortChange={(next) => void changeEffort(next)}
                onManageModels={() => setSettings('modelos')}
                onSend={send}
                onStop={() => void toi.flow.stop()}
                onRetry={retry}
                onDismissNotice={() => setNotice(null)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
};
