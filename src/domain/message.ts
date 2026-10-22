import type { AppErrorInfo } from './error';
import type { ConversationId, MessageId, ProviderId } from './ids';
import type { StopReason, Usage } from './usage';

export type Part = { type: 'text'; text: string } | { type: 'reasoning'; text: string; signature: string };

export type PartKind = Part['type'];

export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'failed';

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: 'user' | 'assistant';
  parts: Part[];
  status: MessageStatus;
  /** Tentar de novo recria a resposta e reinicia este instante com ela. */
  createdAt: number;
  completedAt: number | null;
  /**
   * Primeiro `delta` do Fluxo, de qualquer Parte. `null` na Mensagem do user
   * e antes do primeiro delta.
   */
  firstTokenAt: number | null;
  /** Quem gerou a resposta; `null` na Mensagem do user, como `model`. */
  provider: ProviderId | null;
  model: string | null;
  usage: Usage | null;
  stopReason: StopReason | null;
  error: AppErrorInfo | null;
}

export const closeMessage = (
  message: Message,
  status: Exclude<MessageStatus, 'streaming'>,
  now: number,
  error: AppErrorInfo | null = null,
): Message => ({ ...message, status, completedAt: now, error });

/** Ritmo de uma resposta, no relógio do app. */
export interface Timing {
  /**
   * Da criação da Mensagem ao primeiro `delta`, a espera que a pessoa sente:
   * inclui as escritas locais e o raciocínio oculto, que não emite delta.
   */
  firstTokenMs: number;
  /**
   * `outputTokens` conta o raciocínio oculto, que o Fluxo não mostra; só a
   * resposta inteira, da criação a `completedAt`, cobre o tempo em que ele foi
   * gerado. Inclui a latência da rede. `null` quando o intervalo é zero.
   */
  tokensPerSecond: number | null;
}

/** Só a resposta `complete` tem o `usage` final; fora dela a contagem de saída é parcial. */
export const finalUsageOf = (message: Message): Usage | null =>
  message.status === 'complete' ? message.usage : null;

/** Sem `firstTokenAt` a resposta fechou sem nenhum delta e não há espera a medir. */
export const timingOf = (message: Message): Timing | null => {
  const usage = finalUsageOf(message);
  if (usage === null || message.firstTokenAt === null || message.completedAt === null) return null;

  const answerMs = message.completedAt - message.createdAt;

  return {
    firstTokenMs: message.firstTokenAt - message.createdAt,
    tokensPerSecond: answerMs > 0 ? usage.outputTokens / (answerMs / 1000) : null,
  };
};

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

/** Um `delta` do Fluxo. O primeiro, de qualquer Parte, encerra a espera; só o texto vira Parte. */
export const receiveDelta = (
  message: Message,
  part: PartKind,
  text: string,
  now: number,
): Message => {
  const timed = message.firstTokenAt === null ? { ...message, firstTokenAt: now } : message;
  return part === 'text' ? appendText(timed, text) : timed;
};
