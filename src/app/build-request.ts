import type { Model } from '../domain/model';
import type { Message, Part } from '../domain/message';
import type { ChatMessage, ChatRequest } from '../ports/chat-provider';
import type { TokenEstimator } from '../ports/token-estimator';

const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const CONTEXT_BUDGET = 0.8;

export interface BuildRequestInput {
  messages: Message[];
  model: Model;
  estimator: TokenEstimator;
}

export interface BuiltRequest {
  request: ChatRequest;
  truncated: boolean;
}

/**
 * Partes que voltam ao Provedor. Raciocínio fica de fora até existir a decisão
 * sobre reenviar `signature` (`architecture.md` §1); texto vazio a API recusa.
 */
const outgoingParts = (message: Message): Part[] =>
  message.parts.flatMap((part): Part[] => {
    if (part.type !== 'text') return [];

    const text = part.text.trim();
    return text ? [{ type: 'text', text }] : [];
  });

const mergeAdjacent = (messages: ChatMessage[]): ChatMessage[] => {
  const merged: ChatMessage[] = [];

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

const toTurns = (messages: ChatMessage[]): ChatMessage[][] => {
  const turns: ChatMessage[][] = [];

  for (const message of messages) {
    if (message.role === 'user' || turns.length === 0) {
      turns.push([message]);
      continue;
    }

    turns[turns.length - 1]!.push(message);
  }

  return turns;
};

const costOf = (messages: ChatMessage[], estimator: TokenEstimator): number =>
  messages.reduce(
    (total, message) =>
      total + message.parts.reduce((sum, part) => sum + estimator.estimate(part.text), 0),
    0,
  );

export const buildRequest = ({ messages, model, estimator }: BuildRequestInput): BuiltRequest => {
  const candidates: ChatMessage[] = messages
    .filter((message) => message.status !== 'streaming')
    .map((message): ChatMessage => ({ role: message.role, parts: outgoingParts(message) }))
    .filter((message) => message.parts.length > 0);

  let normalized = mergeAdjacent(candidates);

  // Após mergeAdjacent os papéis alternam: sobra no máximo uma ponta de assistant de cada lado.
  if (normalized[0]?.role === 'assistant') normalized = normalized.slice(1);
  if (normalized[normalized.length - 1]?.role === 'assistant') normalized = normalized.slice(0, -1);

  if (normalized.length === 0) {
    throw new Error('buildRequest precisa terminar com uma Mensagem do user.');
  }

  const maxInputTokens = model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const budget = Math.max(1, Math.floor(maxInputTokens * CONTEXT_BUDGET));

  // Mantém o primeiro Turno e o último, e volta no histórico enquanto couber no orçamento.
  const turns = toTurns(normalized);
  let total = costOf(turns[0]!, estimator);
  let oldestKept = turns.length;

  for (let index = turns.length - 1; index >= 1; index -= 1) {
    const cost = costOf(turns[index]!, estimator);
    if (index !== turns.length - 1 && total + cost > budget) break;

    total += cost;
    oldestKept = index;
  }

  const selected = [...turns[0]!, ...turns.slice(oldestKept).flat()];
  const truncated = selected.length < normalized.length;

  const configuredMax = model.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxTokens = Math.min(
    DEFAULT_MAX_OUTPUT_TOKENS,
    Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_OUTPUT_TOKENS,
  );

  return {
    request: {
      model: model.id,
      maxTokens,
      messages: selected,
    },
    truncated,
  };
};
