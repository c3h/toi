import type { ThemedToken } from 'shiki/core';
import type { Language } from './languages';

/** O que volta do worker: o texto e as cores dos dois temas em variáveis. */
export type Token = Pick<ThemedToken, 'content' | 'htmlStyle'>;

export interface HighlightRequest {
  id: number;
  code: string;
  lang: Language;
}

/** `tokens` é `null` quando a gramática não baixou. */
export interface HighlightReply {
  id: number;
  tokens: Token[][] | null;
}

const pending = new Map<number, (tokens: Token[][] | null) => void>();
let next = 0;

/**
 * O Shiki tokeniza num worker de módulo, criado no primeiro bloco fechado; a
 * main thread só recebe os tokens. Worker que caiu fica `failed` até recarregar.
 */
let worker: Worker | 'failed' | null = null;

const start = (): Worker => {
  const created = new Worker(new URL('./highlight.worker.ts', import.meta.url), {
    type: 'module',
  });

  created.addEventListener('message', ({ data }: MessageEvent<HighlightReply>) => {
    pending.get(data.id)!(data.tokens);
    pending.delete(data.id);
  });

  // O arquivo do worker que um deploy apagou chega como 404 e também cai aqui.
  created.addEventListener('error', () => {
    created.terminate();
    worker = 'failed';
    for (const settle of pending.values()) settle(null);
    pending.clear();
  });

  return created;
};

/** Tokens do código; `null` quando o worker ou a gramática não baixam. */
export const highlight = (code: string, lang: Language): Promise<Token[][] | null> => {
  if (worker === 'failed') return Promise.resolve(null);
  worker ??= start();

  const id = next++;
  const request: HighlightRequest = { id, code, lang };
  worker.postMessage(request);
  return new Promise((resolve) => pending.set(id, resolve));
};
