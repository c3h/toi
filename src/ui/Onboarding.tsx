import { useEffect, useRef, useState } from 'react';
import type { ProviderInfo, Toi } from '../app/toi';
import type { AppErrorInfo } from '../domain/error';
import type { Model } from '../domain/model';
import { errorInfo, linkClass, lower } from './support';

interface OnboardingProps {
  toi: Toi;
  provider: ProviderInfo;
  onConnected: (models: Model[]) => void;
  /** Presente quando já existe uma Chave e a pessoa só está trocando. */
  onCancel?: () => void;
}

export const Onboarding = ({ toi, provider, onConnected, onCancel }: OnboardingProps) => {
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<AppErrorInfo | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    if (!onCancel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const submit = async () => {
    if (!key.trim() || checking) return;

    const current = new AbortController();
    controller.current = current;
    setChecking(true);
    setError(null);

    try {
      const models = await toi.connect(provider.id, key, current.signal);
      setKey('');
      onConnected(models);
    } catch (cause) {
      if (!current.signal.aborted) setError(errorInfo(cause));
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-[min(100%-3rem,842px)] flex-col justify-center py-16">
      <h1 className="text-6xl leading-none font-bold tracking-tight text-text sm:text-8xl">
        toi
      </h1>
      <p className="mt-6 text-base text-muted">
        chat local-first · modelos {provider.of.toLowerCase()} · sem servidor no meio
      </p>
      <p className="mt-6 max-w-[64ch] text-base leading-relaxed text-text">
        o histórico fica neste navegador. a única coisa que sai daqui é a conversa enviada{' '}
        {provider.to.toLowerCase()} para gerar a resposta.
      </p>

      <hr className="my-10 border-line" />

      <form
        className="max-w-[34rem]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="api-key" className="section-title text-2xl font-bold text-text">
          chave da api
        </label>
        <input
          id="api-key"
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={provider.keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-invalid={error !== null}
          aria-describedby={error ? 'key-error' : 'key-hint'}
          className="mt-5 w-full border border-line bg-panel px-4 py-3 text-base text-text outline-none transition-colors placeholder:text-subtle focus:border-accent aria-invalid:border-danger"
        />

        {error ? (
          <p id="key-error" role="alert" className="mt-3 text-sm text-danger">
            {lower(error.message)}
          </p>
        ) : (
          <p id="key-hint" className="mt-3 text-sm leading-relaxed text-subtle">
            crie uma no{' '}
            <a
              href={provider.keysUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              console {provider.of.toLowerCase()}
            </a>
            . ela fica guardada neste navegador e só é enviada {provider.to.toLowerCase()}, para
            autenticar.
          </p>
        )}

        <div className="mt-8 flex items-center gap-6 text-base">
          <button
            type="submit"
            disabled={!key.trim() || checking}
            className="border border-accent px-4 py-2 text-accent transition-colors hover:bg-accent hover:text-bg disabled:border-line disabled:text-subtle disabled:hover:bg-transparent"
          >
            {checking ? 'validando…' : 'conectar'}
          </button>
          {onCancel && (
            <button type="button" className="text-muted hover:text-accent" onClick={onCancel}>
              <span className="text-subtle">[esc]</span> manter a chave atual
            </button>
          )}
        </div>
      </form>
    </main>
  );
};
