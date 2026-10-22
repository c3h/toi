import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { ProviderInfo, ServiceInfo, Toi } from '../app/toi';
import type { AppErrorInfo } from '../domain/error';
import {
  findModel,
  modelFamilies,
  refOf,
  titleModelOf,
  togglePick,
  type Model,
  type ModelPicks,
  type ModelRef,
} from '../domain/model';
import { DEFAULT_TOOL_SPACE, TOOL_SPACES, type ToolSpace } from '../domain/web';
import { download, errorInfo, linkClass, lower, requestPersistence } from './support';
import { readTheme, saveTheme, type ThemePref } from './theme';

export type SettingsSection = 'top' | 'modelos' | 'busca';

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

/**
 * Uma escolha entre poucas opções, com radios nativos: setas trocam a
 * seleção e o grupo é uma parada só de Tab. O `[×]` é só visual.
 */
const Choices = <T extends string | number>({
  name,
  legend,
  options,
  value,
  onChange,
}: {
  name: string;
  /** O nome do grupo para leitor de tela; o título visível fica com quem usa. */
  legend: string;
  options: Array<{ value: T; label: ReactNode }>;
  /** `null` enquanto a escolha gravada não chegou: as opções ficam desabilitadas. */
  value: T | null;
  onChange: (value: T) => void;
}) => (
  <fieldset className="flex flex-wrap gap-x-5 gap-y-2" disabled={value === null}>
    <legend className="sr-only">{legend}</legend>
    {options.map((option) => {
      const checked = option.value === value;
      return (
        <label
          key={option.value}
          className={`cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid ${checked ? 'text-accent' : 'text-muted hover:text-text'}`}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={checked}
            onChange={() => onChange(option.value)}
          />
          <span aria-hidden className="text-subtle">
            [{checked ? '×' : ' '}]
          </span>{' '}
          {option.label}
        </label>
      );
    })}
  </fieldset>
);

const SPACE_LABELS: Record<ToolSpace, string> = {
  20_000: '20 mil',
  40_000: '40 mil',
  80_000: '80 mil',
};

/**
 * Quanto as buscas de uma resposta podem ocupar do contexto. Gravar é
 * otimista e volta à escolha anterior se falhar.
 */
const ToolSpaceChoice = ({ toi }: { toi: Toi }) => {
  const [space, setSpace] = useState<ToolSpace | null>(null);
  const [error, setError] = useState<AppErrorInfo | null>(null);

  useEffect(() => {
    let live = true;
    toi.toolSpace().then(
      (value) => {
        if (live) setSpace(value);
      },
      (cause) => {
        if (live) setError(errorInfo(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [toi]);

  const choose = async (value: ToolSpace) => {
    const previous = space;
    setSpace(value);
    setError(null);
    try {
      await toi.saveToolSpace(value);
    } catch (cause) {
      setSpace(previous);
      setError(errorInfo(cause));
    }
  };

  return (
    <div className="space-y-2">
      <p aria-hidden className="text-text">
        espaço por resposta
      </p>
      <Choices
        name="tool-space"
        legend="espaço por resposta"
        value={space}
        onChange={(value) => void choose(value)}
        options={TOOL_SPACES.map((value) => ({
          value,
          label: (
            <>
              {SPACE_LABELS[value]}
              {value === DEFAULT_TOOL_SPACE && <span className="text-subtle"> · padrão</span>}
            </>
          ),
        }))}
      />
      <p className="text-sm text-subtle">
        quantos tokens as buscas e leituras de uma resposta podem ocupar, com o que o modelo pensa e
        escreve entre elas. com mais espaço ele pode pesquisar mais a fundo, mas vai menos da
        conversa antiga junto. vale a partir do próximo envio.
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {lower(error.message)}
        </p>
      )}
    </div>
  );
};

const keyOf = (model: ModelRef): string => `${model.provider}:${model.id}`;

/**
 * O Modelo que nomeia as Conversas, entre os do seletor. Gravar é otimista e
 * volta à escolha anterior se falhar.
 */
const TitleModelChoice = ({
  toi,
  provider,
  picked,
}: {
  toi: Toi;
  provider: ProviderInfo;
  picked: Model[];
}) => {
  // `undefined` enquanto a escolha gravada não chegou; `null` é a pessoa sem escolha.
  const [saved, setSaved] = useState<ModelRef | null | undefined>(undefined);
  const [error, setError] = useState<AppErrorInfo | null>(null);

  useEffect(() => {
    let live = true;
    toi.titleModel().then(
      (ref) => {
        if (live) setSaved(ref);
      },
      (cause) => {
        if (live) setError(errorInfo(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [toi]);

  const suggested = titleModelOf(picked, null, toi.titleFamilies());
  const current =
    saved === undefined ? null : saved === null ? suggested : findModel(picked, saved);

  const choose = async (ref: ModelRef) => {
    const previous = saved;
    setSaved(ref);
    setError(null);
    try {
      await toi.saveTitleModel(ref);
    } catch (cause) {
      setSaved(previous);
      setError(errorInfo(cause));
    }
  };

  return (
    <div className="space-y-2">
      <Choices
        name="title-model"
        legend="modelo do título"
        // Fora do seletor nenhum fica marcado, mas a escolha segue aberta.
        value={saved === undefined ? null : current === null ? '' : keyOf(current)}
        onChange={(key) => {
          const model = picked.find((item) => keyOf(item) === key);
          if (model) void choose(refOf(model));
        }}
        options={picked.map((model) => ({
          value: keyOf(model),
          label: (
            <>
              {model.displayName.toLowerCase()}
              {model === suggested && <span className="text-subtle"> · padrão</span>}
            </>
          ),
        }))}
      />
      <p className="text-sm text-subtle">
        quando a primeira resposta termina, o modelo lê a sua mensagem e o começo da resposta e dá
        um nome curto à conversa, sem raciocinar. até lá, ou se não der, fica o começo da mensagem.
        a lista é a do seletor.
      </p>
      {current !== null && !current.reasoningOff && (
        <p className="text-sm text-text">
          este modelo sempre raciocina; nomeia com o esforço mínimo.
        </p>
      )}
      {saved !== undefined && current === null && (
        <p className="text-sm text-danger">
          {saved === null
            ? `nenhum ${provider.titleFamily} no seletor`
            : 'o modelo escolhido saiu do seletor'}
          ; escolha outro ou as conversas novas ficam com o começo da mensagem.
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {lower(error.message)}
        </p>
      )}
    </div>
  );
};

/**
 * A Chave do Serviço das Ferramentas. Com ela o Modelo pode buscar e ler
 * páginas; a copy diz o que sai, para quem, e que remover para a resposta em
 * andamento.
 */
const SearchKey = ({ toi, service }: { toi: Toi; service: ServiceInfo }) => {
  const [connected, setConnected] = useState(() => toi.serviceConnected(service.id));
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<AppErrorInfo | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const submit = async () => {
    if (!key.trim() || checking) return;
    const current = new AbortController();
    controller.current = current;
    setChecking(true);
    setError(null);
    try {
      await toi.connectService(service.id, key, current.signal);
      setKey('');
      setConnected(true);
      setEditing(false);
    } catch (cause) {
      if (current.signal.aborted) return;
      const info = errorInfo(cause);
      // Só a recusa fala da Chave; cota, limite e rede não deixam saber se ela vale.
      setError(
        info.code === 'tool_invalid_credential'
          ? info
          : { ...info, message: `Não deu para validar a chave agora: ${lower(info.message)}` },
      );
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await toi.disconnectService(service.id);
      setConnected(false);
    } catch (cause) {
      setError(errorInfo(cause));
    } finally {
      setRemoving(false);
    }
  };

  const name = service.name.toLowerCase();

  return (
    <>
      <p>
        com uma chave {service.of.toLowerCase()}, o modelo pode buscar na web e ler páginas durante a
        resposta, quando achar útil. sem chave, ele responde só com o que já sabe.
      </p>
      <p>
        o que sai daqui: o texto das buscas, que o modelo escreve e pode trazer trechos da conversa, e
        os endereços das páginas que ele lê, só entre os que já apareceram na conversa. vai só{' '}
        {service.to.toLowerCase()}, cujos{' '}
        <a href={service.termsUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
          termos
        </a>{' '}
        permitem usar esses dados para treinar modelos.
      </p>

      {connected && !editing ? (
        <>
          <p className="text-text">
            <span className="text-accent">[×]</span> busca ligada pela {name}.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Action onClick={() => setEditing(true)}>trocar chave</Action>
            <Action danger onClick={() => setRemoving(true)}>
              remover chave
            </Action>
          </div>
          {removing && (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2" role="group">
              <span className="text-text">remover a chave? a resposta em andamento para.</span>
              <Action danger onClick={() => void remove()}>
                sim, continuar
              </Action>
              <button
                type="button"
                className="text-subtle hover:text-text"
                onClick={() => setRemoving(false)}
              >
                cancelar
              </button>
            </div>
          )}
          <ToolSpaceChoice toi={toi} />
        </>
      ) : (
        <form
          className="max-w-[34rem]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="search-key" className="sr-only">
            chave {service.of.toLowerCase()}
          </label>
          <div className="flex gap-3">
            <input
              id="search-key"
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={service.keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error !== null}
              aria-describedby="search-key-hint"
              className="min-w-0 flex-1 border border-line bg-panel px-3 py-2 text-base text-text outline-none transition-colors placeholder:text-subtle focus:border-accent aria-invalid:border-danger"
            />
            <button
              type="submit"
              disabled={!key.trim() || checking}
              className="flex-none border border-accent px-3 py-2 text-accent transition-colors hover:bg-accent hover:text-bg disabled:border-line disabled:text-subtle disabled:hover:bg-transparent"
            >
              {checking ? 'validando…' : 'conectar'}
            </button>
          </div>
          <p id="search-key-hint" className="mt-3 text-sm text-subtle">
            crie uma em{' '}
            <a href={service.keysUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {new URL(service.keysUrl).host}
            </a>
            . ela fica neste navegador e só vai {service.to.toLowerCase()}.
            {editing && (
              <>
                {' '}
                <button
                  type="button"
                  className="text-muted hover:text-accent"
                  onClick={() => {
                    controller.current?.abort();
                    setEditing(false);
                    setKey('');
                    setError(null);
                  }}
                >
                  manter a atual
                </button>
              </>
            )}
          </p>
        </form>
      )}

      {error && (
        <p role="alert" className="text-danger">
          {lower(error.message)}
        </p>
      )}
    </>
  );
};

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
  const searchSection = useRef<HTMLElement>(null);
  const service = toi.services()[0]!;

  useEffect(() => {
    if (section === 'modelos') modelsSection.current?.scrollIntoView();
    if (section === 'busca') searchSection.current?.scrollIntoView();
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
          <Choices
            name="theme"
            legend="tema"
            value={theme}
            onChange={(value) => {
              saveTheme(value);
              setTheme(value);
            }}
            options={THEMES.map(([value, label]) => ({ value, label }))}
          />
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

        <Section title="título das conversas">
          <TitleModelChoice toi={toi} provider={provider} picked={picked} />
        </Section>

        <Section ref={searchSection} title="busca na web">
          <SearchKey toi={toi} service={service} />
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
            'apagar conversas, configurações e as chaves? não tem volta.',
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
