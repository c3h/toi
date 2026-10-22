import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { ProviderInfo, Toi } from '../app/toi';
import type { AppErrorInfo } from '../domain/error';
import { modelFamilies, togglePick, type Model, type ModelPicks } from '../domain/model';
import { download, errorInfo, lower, requestPersistence } from './support';
import { readTheme, saveTheme, type ThemePref } from './theme';

export type SettingsSection = 'top' | 'modelos';

export interface ModelPicksError {
  kind: 'read' | 'save';
  error: AppErrorInfo;
}

export interface ModelsState {
  list: Model[];
  /** Falha do último refresh; a lista exibida é o cache anterior. */
  stale: AppErrorInfo | null;
  refreshing: boolean;
}

interface SettingsProps {
  toi: Toi;
  provider: ProviderInfo;
  models: ModelsState;
  modelPicks: ModelPicks;
  /** Os Modelos que o seletor oferece, já calculados pelo App. */
  picked: Model[];
  modelPicksError: ModelPicksError | null;
  /** Onde Configurações abre. */
  section: SettingsSection;
  conversationCount: number;
  onRefreshModels: () => void;
  onModelPicksChange: (picks: ModelPicks) => void;
  onChangeKey: () => void;
  onKeyRemoved: () => void;
  onErasedAll: () => void;
  onClose: () => void;
}

type Confirming = 'remove_key' | 'erase_conversations' | 'erase_all' | null;

const Section = ({
  ref,
  title,
  children,
}: {
  ref?: Ref<HTMLElement>;
  title: string;
  children: ReactNode;
}) => (
  <section ref={ref} className="scroll-mt-10 border-t border-line py-9 first:border-t-0 first:pt-0">
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

/** Uma família por bloco, da versão mais recente para a mais antiga. */
const ModelList = ({
  models,
  picks,
  picked,
  onChange,
}: {
  models: Model[];
  picks: ModelPicks;
  picked: Model[];
  onChange: (picks: ModelPicks) => void;
}) => (
  <div className="grid gap-x-10 gap-y-6 pt-1 sm:grid-cols-2">
    {modelFamilies(models).map((family) => (
      <div key={`${family.provider}:${family.name}`}>
        <h3 className="text-sm text-subtle">{family.name}</h3>
        <ul className="mt-2 space-y-1.5" aria-label={family.name}>
          {family.models.map((model, index) => {
            const checked = picked.includes(model);
            // O seletor nunca fica vazio: o último marcado não sai.
            const last = checked && picked.length === 1;
            return (
              <li key={`${model.provider}:${model.id}`} className="flex items-baseline gap-3">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-disabled={last}
                  title={last ? 'o seletor precisa de pelo menos um modelo' : undefined}
                  onClick={() => {
                    if (!last) onChange(togglePick(family, picks, model));
                  }}
                  className={`text-left ${
                    checked ? 'text-accent' : 'text-muted hover:text-text'
                  } ${last ? 'cursor-default' : ''}`}
                >
                  <span className="text-subtle">[{checked ? '×' : ' '}]</span>{' '}
                  {model.displayName.toLowerCase()}
                </button>
                {index === 0 && family.models.length > 1 && (
                  <span className="text-xs text-subtle">mais recente</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    ))}
  </div>
);

const THEMES: Array<[ThemePref, string]> = [
  ['system', 'sistema'],
  ['light', 'claro'],
  ['dark', 'escuro'],
];

export default function Settings({
  toi,
  provider,
  models,
  modelPicks,
  picked,
  modelPicksError,
  section,
  conversationCount,
  onRefreshModels,
  onModelPicksChange,
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

  const modelsSection = useRef<HTMLElement>(null);

  useEffect(() => {
    if (section === 'modelos') modelsSection.current?.scrollIntoView();
  }, [section]);

  useEffect(() => {
    void navigator.storage.persisted().then(setPersisted, () => setPersisted(null));
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
      download(`toi-historico-${date}.json`, await toi.exportHistory());
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
                await toi.disconnect(provider.id);
                onKeyRemoved();
              }, null),
          )}
        </Section>

        <Section ref={modelsSection} title="modelos">
          <p>
            o seletor da conversa mostra só os marcados. a versão mais recente de uma família
            acompanha os lançamentos; as anteriores ficam fixas.
          </p>
          <ModelList
            models={models.list}
            picks={modelPicks}
            picked={picked}
            onChange={onModelPicksChange}
          />
          {modelPicksError && (
            <p className="text-danger">
              {modelPicksError.kind === 'read'
                ? 'não deu para ler a escolha salva; o seletor está no padrão'
                : 'a última mudança não foi salva'}
              : {lower(modelPicksError.error.message)}
            </p>
          )}
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
