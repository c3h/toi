import type { Attachment } from './attachment';
import type { AppErrorInfo } from './error';
import type { ConversationId, MessageId, ProviderId } from './ids';
import type { JsonObject } from './json';
import type { Effort } from './model';
import type { StopReason, Usage } from './usage';
import type { FetchFailure, Source } from './web';

/** Um pedido do Modelo a uma Ferramenta, com o input como veio, para voltar igual ao Provedor. */
export interface ToolCallPart {
  type: 'tool_call';
  callId: string;
  tool: string;
  input: JsonObject;
}

/**
 * O que o toi devolveu ao Modelo. `content` é o texto entregue, montado das
 * Fontes e das falhas; `failures` são as URLs de uma Leitura que não abriram;
 * `error` é a falha da chamada inteira. Sucesso parcial é `error: null` com
 * `failures` não vazio.
 */
export interface ToolResultPart {
  type: 'tool_result';
  callId: string;
  content: string;
  sources: Source[];
  failures: FetchFailure[];
  error: AppErrorInfo | null;
}

export type Part =
  | { type: 'text'; text: string }
  /** `text` pode vir vazio: o Modelo raciocina sem mostrar. A `signature` volta igual ao Provedor. */
  | { type: 'reasoning'; text: string; signature: string }
  | { type: 'redacted_reasoning'; data: string }
  /** Só na Mensagem do user, antes do texto; os bytes ficam fora da Mensagem. */
  | { type: 'file'; attachment: Attachment }
  | ToolCallPart
  | ToolResultPart;

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
   * Primeiro `delta` do Fluxo, de qualquer Parte e de qualquer Rodada. `null`
   * na Mensagem do user e antes do primeiro delta.
   */
  firstTokenAt: number | null;
  /** Quem gerou a resposta; `null` na Mensagem do user, como `model`. */
  provider: ProviderId | null;
  model: string | null;
  /** O Esforço pedido; `null` na Mensagem do user, como `model`. */
  effort: Effort | null;
  /** Soma das Rodadas. */
  usage: Usage | null;
  /** Da última Rodada, gravado só no término lógico. */
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
   * inclui as escritas locais e o raciocínio que não emite delta.
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

/** Os trechos de texto da resposta, em ordem; entre eles pode haver Ferramentas. */
export const textOf = (message: Pick<Message, 'parts'>): string =>
  message.parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');

export const attachmentsOf = (message: Pick<Message, 'parts'>): Attachment[] =>
  message.parts.flatMap((part) => (part.type === 'file' ? [part.attachment] : []));

/** O resultado de cada chamada que já tem um, pelo `callId`; chamada fora do mapa está pendente. */
export const resultsByCall = (parts: Part[]): Map<string, ToolResultPart> =>
  new Map(parts.flatMap((part) => (part.type === 'tool_result' ? [[part.callId, part] as const] : [])));
