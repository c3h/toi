import type { ConversationId } from './ids';

export interface Conversation {
  id: ConversationId;
  title: string;
  model: string;
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
