import { useEffect, useState, type ReactNode } from 'react';
import type { Toi } from '../app/toi';
import type { AppErrorInfo } from '../domain/error';
import type { Model } from '../domain/model';
import { downloadJson, errorInfo, lower, requestPersistence } from './support';
import { readTheme, saveTheme, type ThemePref } from './theme';

export interface ModelsState {
  list: Model[];
  /** Falha do último refresh; a lista exibida é o cache anterior. */
  stale: AppErrorInfo | null;
  refreshing: boolean;
}

interface SettingsProps {
  toi: Toi;
  models: ModelsState;
  conversationCount: number;
  onRefreshModels: () => void;
  onChangeKey: () => void;
  onKeyRemoved: () => void;
  onErasedAll: () => void;
  onClose: () => void;
}

type Confirming = 'remove_key' | 'erase_conversations' | 'erase_all' | null;

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="border-t border-line py-9 first:border-t-0 first:pt-0">
    <h2 className="section-title text-xl font-bold text-text sm:text-2xl">{title}</h2>
    <div className="mt-5 space-y-4 text-base text-muted">{children}</div>
  </section>
);

const Action = ({
  children,
  danger,
  onClick,
  disabled,
}: {
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`transition-colors disabled:text-subtle ${
      danger ? 'text-danger hover:underline' : 'text-accent hover:underline'
    }`}
  >
    {children}
  </button>
);

const THEMES: Array<[ThemePref, string]> = [
  ['system', 'sistema'],
  ['light', 'claro'],
  ['dark', 'escuro'],
];

export default function Settings({
  toi,
  models,
  conversationCount,
  onRefreshModels,
  onChangeKey,
  onKeyRemoved,
  onErasedAll,
  onClose,
}: SettingsProps) {
  const [theme, setTheme] = useState<ThemePref>(readTheme);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorInfo | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(null));
  }, []);

  const run = async (task: () => Promise<void>, message: string | null) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await task();
      setDone(message);
    } catch (cause) {
      setError(errorInfo(cause));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const confirmRow = (kind: Exclude<Confirming, null>, question: string, act: () => void) =>
    confirming === kind ? (
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2" role="group">
        <span className="text-text">{question}</span>
        <Action danger disabled={busy} onClick={act}>
          sim, continuar
        </Action>
        <button
          type="button"
          className="text-subtle hover:text-text"
          onClick={() => setConfirming(null)}
        >
          cancelar
        </button>
      </div>
    ) : null;

  const exportHistory = () =>
    run(async () => {
      const date = new Date().toISOString().slice(0, 10);
      downloadJson(`toi-historico-${date}.json`, await toi.exportHistory());
    }, 'histórico exportado.');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-[min(100%-2rem,44rem)] py-10 sm:py-14">
        <header className="mb-12 flex items-baseline justify-between gap-4">
          <h1 className="text-4xl font-bold tracking-tight text-text sm:text-5xl">
            configurações
          </h1>
          <button
            type="button"
            className="text-sm text-muted hover:text-accent"
            onClick={onClose}
          >
            <span className="hidden text-subtle sm:inline">[esc]</span> voltar
          </button>
        </header>

        {(error || done) && (
          <p
            role="status"
            className={`mb-8 text-sm ${error ? 'text-danger' : 'text-accent'}`}
          >
            * {error ? lower(error.message) : done}
          </p>
        )}

        <Section title="tema">
          <div className="flex gap-5" role="radiogroup" aria-label="tema">
            {THEMES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => {
                  saveTheme(value);
                  setTheme(value);
                }}
                className={theme === value ? 'text-accent' : 'text-muted hover:text-text'}
              >
                <span className="text-subtle">[{theme === value ? '×' : ' '}]</span> {label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="chave">
          <p>guardada só neste navegador. trocar valida a nova antes de substituir a atual.</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Action onClick={onChangeKey}>trocar chave</Action>
            <Action danger onClick={() => setConfirming('remove_key')}>
              remover chave
            </Action>
          </div>
          {confirming === 'remove_key' && <p>o histórico continua aqui; só a chave sai.</p>}
          {confirmRow(
            'remove_key',
            'remover a chave?',
            () =>
              void run(async () => {
                await toi.disconnect();
                onKeyRemoved();
              }, null),
          )}
        </Section>

        <Section title="modelos">
          <p>
            {models.list.length}{' '}
            {models.list.length === 1 ? 'modelo disponível' : 'modelos disponíveis'} para esta
            chave.
          </p>
          {models.stale && (
            <p className="text-danger">
              lista possivelmente desatualizada: {lower(models.stale.message)}
            </p>
          )}
          <Action disabled={models.refreshing} onClick={onRefreshModels}>
            {models.refreshing ? 'atualizando…' : 'atualizar lista'}
          </Action>
        </Section>

        <Section title="armazenamento">
          {persisted === true ? (
            <p>
              o navegador marcou o histórico como persistente; ele não é apagado para liberar
              espaço.
            </p>
          ) : (
            <>
              <p>
                o navegador pode apagar o histórico se faltar espaço. o safari apaga dados de sites
                sem uso por cerca de 7 dias. exporte com frequência.
              </p>
              {persisted === false && (
                <Action
                  onClick={() => void requestPersistence().then(setPersisted)}
                >
                  pedir armazenamento persistente
                </Action>
              )}
            </>
          )}
        </Section>

        <Section title="dados">
          <p>
            {conversationCount} {conversationCount === 1 ? 'conversa' : 'conversas'} neste
            navegador. a exportação é um json versionado e nunca inclui a chave.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Action disabled={busy} onClick={() => void exportHistory()}>
              exportar histórico
            </Action>
            <Action danger onClick={() => setConfirming('erase_conversations')}>
              apagar conversas
            </Action>
            <Action danger onClick={() => setConfirming('erase_all')}>
              apagar tudo
            </Action>
          </div>
          {confirmRow(
            'erase_conversations',
            `apagar ${conversationCount === 1 ? 'a conversa' : `as ${conversationCount} conversas`}? a chave fica.`,
            () => void run(() => toi.eraseConversations(), 'conversas apagadas.'),
          )}
          {confirmRow(
            'erase_all',
            'apagar conversas, configurações e a chave? não tem volta.',
            () =>
              void run(async () => {
                await toi.eraseAll();
                saveTheme('system');
                onErasedAll();
              }, null),
          )}
        </Section>
      </div>
    </div>
  );
}
