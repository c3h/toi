import {
  pagesOf,
  requestBytesOf,
  requestLimits,
  type Attachment,
  type RequestLimits,
} from '../domain/attachment';
import type { AttachmentId } from '../domain/ids';
import { attachmentsOf, type Message } from '../domain/message';
import type { Effort, Model } from '../domain/model';
import type { ChatRequest, OutgoingPart } from '../ports/chat-provider';
import type { TokenEstimator } from '../ports/token-estimator';

const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const CONTEXT_BUDGET = 0.8;

/** Uma Parte escolhida para a requisição; o Anexo ainda sem bytes, lidos só se coube. */
export type SelectedPart =
  | { type: 'text'; text: string }
  | { type: 'file'; attachment: Attachment };

export interface SelectedMessage {
  role: 'user' | 'assistant';
  parts: SelectedPart[];
}

/** O que ficou fora do contexto para caber no Modelo. */
export interface Truncation {
  /** Turnos do meio cortados pelo orçamento de tokens. */
  turns: boolean;
  /** Anexos antigos trocados por um marcador. */
  attachments: boolean;
}

export interface SelectedHistory {
  model: string;
  maxTokens: number;
  effort: Effort;
  messages: SelectedMessage[];
  truncated: Truncation | null;
}

export interface SelectHistoryInput {
  messages: Message[];
  model: Model;
  effort: Effort;
  estimator: TokenEstimator;
}

/**
 * Partes que voltam ao Provedor. Raciocínio fica de fora até existir a decisão
 * sobre reenviar `signature` (`architecture.md` §1); texto vazio a API recusa.
 */
const outgoingParts = (message: Message): SelectedPart[] =>
  message.parts.flatMap((part): SelectedPart[] => {
    if (part.type === 'file') return [part];
    if (part.type !== 'text') return [];

    const text = part.text.trim();
    return text ? [{ type: 'text', text }] : [];
  });

const mergeAdjacent = (messages: SelectedMessage[]): SelectedMessage[] => {
  const merged: SelectedMessage[] = [];

  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      merged[merged.length - 1] = { role: last.role, parts: [...last.parts, ...message.parts] };
      continue;
    }

    merged.push(message);
  }

  return merged;
};

const toTurns = (messages: SelectedMessage[]): SelectedMessage[][] => {
  const turns: SelectedMessage[][] = [];

  for (const message of messages) {
    if (message.role === 'user' || turns.length === 0) {
      turns.push([message]);
      continue;
    }

    turns[turns.length - 1]!.push(message);
  }

  return turns;
};

/** O que o Modelo lê no lugar de um Anexo que saiu do contexto; nunca é gravado. */
export const elisionMarker = (name: string): string =>
  `[Attachment "${name}" was removed from the context to fit the model's limits; ` +
  'do not assume its content.]';

/** Quanto uma Parte pesa em cada teto da requisição. */
interface Weight {
  bytes: number;
  pages: number;
  files: number;
  tokens: number;
}

const encoder = new TextEncoder();

const tokensOf = (part: SelectedPart, estimator: TokenEstimator): number =>
  part.type === 'text'
    ? estimator.estimate(part.text)
    : estimator.estimateAttachment(part.attachment);

const weightOf = (part: SelectedPart, estimator: TokenEstimator): Weight =>
  part.type === 'text'
    ? {
        bytes: encoder.encode(part.text).length,
        pages: 0,
        files: 0,
        tokens: tokensOf(part, estimator),
      }
    : {
        bytes: requestBytesOf(part.attachment),
        pages: pagesOf(part.attachment),
        files: 1,
        tokens: tokensOf(part, estimator),
      };

const add = (a: Weight, b: Weight, sign = 1): Weight => ({
  bytes: a.bytes + sign * b.bytes,
  pages: a.pages + sign * b.pages,
  files: a.files + sign * b.files,
  tokens: a.tokens + sign * b.tokens,
});

const ZERO: Weight = { bytes: 0, pages: 0, files: 0, tokens: 0 };

const weightOfTurn = (turn: SelectedMessage[], estimator: TokenEstimator): Weight =>
  turn
    .flatMap((message) => message.parts)
    .reduce((total, part) => add(total, weightOf(part, estimator)), ZERO);

const exceeds = (weight: Weight, limits: RequestLimits, tokenBudget: number): boolean =>
  weight.bytes > limits.bytes ||
  weight.pages > limits.pages ||
  weight.files > limits.files ||
  weight.tokens > tokenBudget;

/**
 * Troca Anexos por marcadores, do mais antigo para o mais novo, enquanto a
 * requisição passa de algum teto. O turno atual fica inteiro: uma Mensagem
 * sozinha nunca passa dos tetos de anexo (`MESSAGE_LIMITS`).
 */
const elideAttachments = (
  turns: SelectedMessage[][],
  limits: RequestLimits,
  tokenBudget: number,
  estimator: TokenEstimator,
): { turns: SelectedMessage[][]; elided: boolean } => {
  const older = turns
    .slice(0, -1)
    .flat()
    .flatMap((message) => message.parts);
  // Sem Anexo antigo não há o que trocar; o caso comum não mede os bytes do histórico.
  if (!older.some((part) => part.type === 'file')) return { turns, elided: false };

  let total = turns.reduce((sum, turn) => add(sum, weightOfTurn(turn, estimator)), ZERO);
  const markers = new Map<AttachmentId, SelectedPart>();

  for (const part of older) {
    if (!exceeds(total, limits, tokenBudget)) break;
    if (part.type !== 'file') continue;

    const marker: SelectedPart = { type: 'text', text: elisionMarker(part.attachment.name) };
    total = add(add(total, weightOf(part, estimator), -1), weightOf(marker, estimator));
    markers.set(part.attachment.id, marker);
  }

  if (markers.size === 0) return { turns, elided: false };

  const replace = (part: SelectedPart): SelectedPart =>
    part.type === 'file' ? (markers.get(part.attachment.id) ?? part) : part;

  return {
    turns: turns.map((turn) =>
      turn.map((message) => ({ ...message, parts: message.parts.map(replace) })),
    ),
    elided: true,
  };
};

/**
 * Escolhe o que vai ao Provedor: normaliza papéis, tira Anexos antigos que
 * passam dos tetos da API e, se os tokens ainda passam do orçamento, corta
 * turnos do meio. Não lê bytes; `toChatRequest` lê só os Anexos que ficaram.
 */
export const selectHistory = ({
  messages,
  model,
  effort,
  estimator,
}: SelectHistoryInput): SelectedHistory => {
  const candidates: SelectedMessage[] = messages
    .filter((message) => message.status !== 'streaming')
    .map((message): SelectedMessage => ({ role: message.role, parts: outgoingParts(message) }))
    .filter((message) => message.parts.length > 0);

  let normalized = mergeAdjacent(candidates);

  // Após mergeAdjacent os papéis alternam: sobra no máximo uma ponta de assistant de cada lado.
  if (normalized[0]?.role === 'assistant') normalized = normalized.slice(1);
  if (normalized[normalized.length - 1]?.role === 'assistant') normalized = normalized.slice(0, -1);

  if (normalized.length === 0) {
    throw new Error('selectHistory precisa terminar com uma Mensagem do user.');
  }

  const maxInputTokens = model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const budget = Math.max(1, Math.floor(maxInputTokens * CONTEXT_BUDGET));

  const { turns, elided } = elideAttachments(
    toTurns(normalized),
    requestLimits(maxInputTokens),
    budget,
    estimator,
  );

  // Mantém o primeiro Turno e o último, e volta no histórico enquanto couber no orçamento.
  const cost = (turn: SelectedMessage[]): number =>
    turn
      .flatMap((message) => message.parts)
      .reduce((sum, part) => sum + tokensOf(part, estimator), 0);
  let total = cost(turns[0]!);
  let oldestKept = turns.length;

  for (let index = turns.length - 1; index >= 1; index -= 1) {
    const turnCost = cost(turns[index]!);
    if (index !== turns.length - 1 && total + turnCost > budget) break;

    total += turnCost;
    oldestKept = index;
  }

  const selected = [...turns[0]!, ...turns.slice(oldestKept).flat()];
  const cutTurns = selected.length < normalized.length;

  const configuredMax = model.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxTokens = Math.min(
    DEFAULT_MAX_OUTPUT_TOKENS,
    Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_OUTPUT_TOKENS,
  );

  return {
    model: model.id,
    maxTokens,
    effort,
    messages: selected,
    truncated: cutTurns || elided ? { turns: cutTurns, attachments: elided } : null,
  };
};

/** Busca os Blobs dos Anexos que ficaram na seleção e monta a requisição da porta. */
export const toChatRequest = async (
  selected: SelectedHistory,
  readAttachments: (ids: AttachmentId[]) => Promise<Blob[]>,
): Promise<ChatRequest> => {
  const ids = selected.messages.flatMap(attachmentsOf).map(({ id }) => id);
  const blobs = await readAttachments(ids);
  const data = new Map(ids.map((id, index) => [id, blobs[index]!]));

  return {
    model: selected.model,
    maxTokens: selected.maxTokens,
    effort: selected.effort,
    messages: selected.messages.map((message) => ({
      role: message.role,
      parts: message.parts.map(
        (part): OutgoingPart =>
          part.type === 'file' ? { ...part, data: data.get(part.attachment.id)! } : part,
      ),
    })),
  };
};
