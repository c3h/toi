import type { AppErrorInfo } from './error';
import type { ConversationId, MessageId } from './ids';
import type { Usage } from './usage';

export type Part = { type: 'text'; text: string } | { type: 'reasoning'; text: string; signature: string };

export type PartKind = Part['type'];

export interface StreamLease {
  owner: string;
  heartbeatAt: number;
}

export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'failed';

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: 'user' | 'assistant';
  parts: Part[];
  status: MessageStatus;
  createdAt: number;
  completedAt: number | null;
  model: string | null;
  usage: Usage | null;
  error: AppErrorInfo | null;
  stream: StreamLease | null;
}

export const leaseOf = (owner: string, now: number): StreamLease => ({ owner, heartbeatAt: now });

export const closeMessage = (
  message: Message,
  status: Exclude<MessageStatus, 'streaming'>,
  now: number,
  error: AppErrorInfo | null = null,
): Message => ({ ...message, status, completedAt: now, error, stream: null });

export const textOf =(message: Message): string =>
  message.parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');

export const appendText = (message: Message, text: string): Message => {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];

  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + text };
  } else {
    parts.push({ type: 'text', text });
  }

  return { ...message, parts };
};
