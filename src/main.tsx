import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { anthropic } from './adapters/providers/anthropic/provider';
import { WebLocks } from './adapters/locks/web';
import { DexieConversationStore } from './adapters/storage/conversations';
import { DexieCredentialStore } from './adapters/storage/credentials';
import { ToiDatabase } from './adapters/storage/db';
import { DexieSettingsStore } from './adapters/storage/settings';
import { heuristicTokenEstimator } from './adapters/tokens/heuristic';
import { createToi } from './app/toi';
import { newId } from './domain/ids';
import { systemClock } from './ports/clock';
import { App } from './ui/App';
import './ui/styles.css';

const element = document.getElementById('root');
if (!element) throw new Error('Elemento #root não encontrado.');
const root = createRoot(element);

const boot = async (): Promise<void> => {
  const db = new ToiDatabase();

  const toi = await createToi({
    store: new DexieConversationStore(db),
    credentials: new DexieCredentialStore(db),
    settings: new DexieSettingsStore(db),
    clock: systemClock,
    estimator: heuristicTokenEstimator,
    newId,
    locks: new WebLocks(navigator.locks),
    providers: [anthropic],
  });

  // Até 300 ms de Fluxo ficam só em memória; sair da página grava o que falta.
  addEventListener('pagehide', () => void toi.flow.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void toi.flow.flush();
  });

  root.render(
    <StrictMode>
      <App toi={toi} />
    </StrictMode>,
  );
};

boot().catch(() => {
  root.render(
    <main className="mx-auto flex min-h-dvh w-[min(100%-3rem,842px)] flex-col justify-center">
      <h1 className="text-6xl leading-none font-bold tracking-tight text-text">toi</h1>
      <p className="mt-6 max-w-[60ch] text-base leading-relaxed text-text">
        <span className="text-danger">*</span> o navegador não deixou abrir o armazenamento local.
        em janela privada alguns navegadores bloqueiam o indexeddb; abra o toi numa janela normal.
      </p>
    </main>,
  );
});
