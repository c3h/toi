import type { ConversationId, ProviderId } from './ids';
import type { Effort } from './model';

/**
 * De onde veio o Título: `derived` é o corte da primeira Mensagem, que o
 * Título gerado pode substituir; `generated` e `manual` ficam.
 */
export type TitleSource = 'derived' | 'generated' | 'manual';

/** `provider`, `model` e `effort` são o destino do próximo envio, não de toda a Conversa. */
export interface Conversation {
  id: ConversationId;
  title: string;
  titleSource: TitleSource;
  provider: ProviderId;
  model: string;
  effort: Effort;
  createdAt: number;
  updatedAt: number;
}

const TITLE_LIMIT = 60;

export const MAX_TITLE_LENGTH = 120;

export const normalizeTitle = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const titleFrom = (text: string): string => {
  const clean = normalizeTitle(text);
  if (clean.length <= TITLE_LIMIT) return clean;

  const cut = clean.slice(0, TITLE_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > TITLE_LIMIT / 2 ? lastSpace : TITLE_LIMIT;

  return `${cut.slice(0, boundary).trimEnd()}…`;
};

/** Aspas, crases e marcação que o Modelo às vezes põe em volta do Título. */
const WRAPPERS = /^[\s"'“”‘’«»`*_#]+|[\s"'“”‘’«»`*_.]+$/g;

/** O Título que o Modelo escreveu, limpo; `null` se não sobra nada. */
export const cleanTitle = (text: string): string | null =>
  titleFrom(text.trim().split('\n')[0]!.replace(WRAPPERS, '')) || null;

/** Só um Título `derived` é substituído: o renomeado e o gerado ficam. */
export const retitle = (
  current: Conversation,
  title: string,
  source: 'derived' | 'generated',
): Conversation =>
  current.titleSource === 'derived' ? { ...current, title, titleSource: source } : current;
