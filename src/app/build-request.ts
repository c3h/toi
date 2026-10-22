import {
  pagesOf,
  requestBytesOf,
  requestLimits,
  type Attachment,
  type RequestLimits,
} from '../domain/attachment';
import type { AttachmentId } from '../domain/ids';
import type { JsonObject } from '../domain/json';
import { resultsByCall, type Message, type Part, type ToolResultPart } from '../domain/message';
import type { Effort, Model } from '../domain/model';
import type { Source } from '../domain/web';
import type { ChatMessage, ChatRequest, OutgoingPart, ToolDefinition } from '../ports/chat-provider';
import type { TokenEstimator } from '../ports/token-estimator';

const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const CONTEXT_BUDGET = 0.8;

/** Uma Parte escolhida para a requisição; o Anexo ainda sem bytes, lidos só se coube. */
export type SelectedPart =
  | { type: 'text'; text: string }
  | { type: 'file'; attachment: Attachment }
  | { type: 'tool_call'; callId: string; tool: string; input: JsonObject }
  | { type: 'tool_result'; callId: string; content: string; isError: boolean; sources: Source[] };

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
  /** Resultados de Ferramenta antigos trocados por um marcador. */
  results: boolean;
}

export interface SelectedHistory {
  model: string;
  maxTokens: number;
  effort: Effort;
  /** O espaço das Rodadas que saiu do orçamento; `null` sem Ferramentas. */
  toolSpace: number | null;
  /** Já na forma da API: cada Rodada de uma resposta antiga vira uma ida e uma volta. */
  messages: SelectedMessage[];
  truncated: Truncation | null;
}

export interface SelectHistoryInput {
  messages: Message[];
  model: Model;
  effort: Effort;
  estimator: TokenEstimator;
  /**
   * O espaço das Rodadas do turno, em tokens, quando o envio oferece
   * Ferramentas; `null` sem elas. Com Ferramentas, as Partes de Ferramenta das
   * respostas do mesmo Provedor voltam, e o espaço sai do orçamento.
   */
  toolSpace: number | null;
}

/**
 * As Rodadas de uma resposta antiga que voltam ao Provedor. Corta a partir da
 * primeira chamada sem resultado, porque a Rodada que não fechou não tem como
 * voltar; uma resposta `complete` nunca tem uma. Tira também as chamadas e
 * resultados depois do último texto: terminar em resultado faria a pergunta
 * seguinte continuar a Rodada, o que o Provedor só aceita com o raciocínio
 * dela, e o de turnos anteriores não volta. Isso acontece quando a resposta
 * parou, passou do limite ou atingiu `max_tokens` antes de escrever depois da
 * última Ferramenta.
 */
const completeRounds = (parts: Part[]): Part[] => {
  const results = resultsByCall(parts);
  const pending = parts.findIndex((part) => part.type === 'tool_call' && !results.has(part.callId));
  const closed = pending === -1 ? parts : parts.slice(0, pending);
  const lastText = closed.reduce(
    (last, part, index) => (part.type === 'text' && part.text.trim() !== '' ? index : last),
    -1,
  );
  return closed.filter(
    (part, index) => index < lastText || (part.type !== 'tool_call' && part.type !== 'tool_result'),
  );
};

/** O resultado como volta ao Provedor. */
const outgoingResult = ({ callId, content, error }: ToolResultPart) => ({
  type: 'tool_result' as const,
  callId,
  content,
  isError: error !== null,
});

/**
 * Partes que voltam ao Provedor. Raciocínio de turnos anteriores não volta
 * (só o da resposta em curso, em `continuationOf`); Partes de Ferramenta só
 * voltam ao Provedor que as gerou e quando o envio oferece Ferramentas; fora
 * disso a resposta volta só como texto. Texto vazio a API recusa.
 */
const outgoingParts = (message: Message, withTools: boolean): SelectedPart[] =>
  (withTools ? completeRounds(message.parts) : message.parts).flatMap((part): SelectedPart[] => {
    switch (part.type) {
      case 'file':
        return [part];
      case 'text': {
        const text = part.text.trim();
        return text ? [{ type: 'text', text }] : [];
      }
      case 'tool_call':
        return withTools ? [part] : [];
      case 'tool_result':
        return withTools ? [{ ...outgoingResult(part), sources: part.sources }] : [];
      case 'reasoning':
      case 'redacted_reasoning':
        return [];
    }
  });

interface Turn<P> {
  role: 'user' | 'assistant';
  parts: P[];
}

const mergeAdjacent = <P>(messages: Turn<P>[]): Turn<P>[] => {
  const merged: Turn<P>[] = [];

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

/** Partes de uma resposta com Rodadas viram, na API, assistant e user alternados: os resultados voltam como user. */
const alternate = <P extends { type: string }>(parts: P[]): Turn<P>[] =>
  mergeAdjacent(
    parts.map(
      (part): Turn<P> => ({
        role: part.type === 'tool_result' ? 'user' : 'assistant',
        parts: [part],
      }),
    ),
  );

const unfold = (messages: SelectedMessage[]): SelectedMessage[] =>
  mergeAdjacent(
    messages.flatMap((message) => (message.role === 'user' ? [message] : alternate(message.parts))),
  );

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

/** O que o Modelo lê no lugar de um resultado de Ferramenta antigo; as Fontes ficam. */
export const resultElisionMarker = (sources: Source[]): string =>
  "[This tool result was removed from the context to fit the model's limits; do not assume its content." +
  (sources.length === 0 ? ']' : ` Sources: ${sources.map(({ url }) => url).join(' ')}]`);

/** Quanto uma Parte pesa em cada teto da requisição. */
interface Weight {
  bytes: number;
  pages: number;
  files: number;
  tokens: number;
}

const encoder = new TextEncoder();

/** O texto que uma Parte leva à requisição; o Anexo pesa à parte. */
const textIn = (part: OutgoingPart | Exclude<SelectedPart, { type: 'file' }>): string => {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text;
    case 'redacted_reasoning':
      return part.data;
    case 'tool_call':
      return JSON.stringify(part.input);
    case 'tool_result':
      return part.content;
    case 'file':
      return '';
  }
};

const tokensOf = (part: SelectedPart, estimator: TokenEstimator): number =>
  part.type === 'file'
    ? estimator.estimateAttachment(part.attachment)
    : estimator.estimate(textIn(part));

const weightOf = (part: SelectedPart, estimator: TokenEstimator): Weight =>
  part.type === 'file'
    ? {
        bytes: requestBytesOf(part.attachment),
        pages: pagesOf(part.attachment),
        files: 1,
        tokens: tokensOf(part, estimator),
      }
    : {
        bytes: encoder.encode(textIn(part)).length,
        pages: 0,
        files: 0,
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

const elidable = (part: SelectedPart): boolean => part.type === 'file' || part.type === 'tool_result';

const markerFor = (part: SelectedPart): SelectedPart => {
  if (part.type === 'file') return { type: 'text', text: elisionMarker(part.attachment.name) };
  if (part.type === 'tool_result') return { ...part, content: resultElisionMarker(part.sources) };
  return part;
};

/**
 * Troca Anexos e resultados de Ferramenta por marcadores, do mais antigo para
 * o mais novo, enquanto a requisição passa de algum teto. O turno atual fica
 * inteiro: uma Mensagem sozinha nunca passa dos tetos de anexo
 * (`MESSAGE_LIMITS`), e os resultados do turno são cortados ao chegar.
 */
const elideOlder = (
  turns: SelectedMessage[][],
  limits: RequestLimits,
  tokenBudget: number,
  estimator: TokenEstimator,
): { turns: SelectedMessage[][]; attachments: boolean; results: boolean } => {
  const older = turns
    .slice(0, -1)
    .flat()
    .flatMap((message) => message.parts);
  // Sem o que trocar, o caso comum não mede os bytes do histórico.
  if (!older.some(elidable)) return { turns, attachments: false, results: false };

  let total = turns.reduce((sum, turn) => add(sum, weightOfTurn(turn, estimator)), ZERO);
  const markers = new Map<SelectedPart, SelectedPart>();

  for (const part of older) {
    if (!exceeds(total, limits, tokenBudget)) break;
    if (!elidable(part)) continue;

    const marker = markerFor(part);
    total = add(add(total, weightOf(part, estimator), -1), weightOf(marker, estimator));
    markers.set(part, marker);
  }

  if (markers.size === 0) return { turns, attachments: false, results: false };

  const elided = [...markers.keys()];
  return {
    turns: turns.map((turn) =>
      turn.map((message) => ({
        ...message,
        parts: message.parts.map((part) => markers.get(part) ?? part),
      })),
    ),
    attachments: elided.some((part) => part.type === 'file'),
    results: elided.some((part) => part.type === 'tool_result'),
  };
};

const outputTokensOf = (model: Model): number => {
  const configuredMax = model.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(
    DEFAULT_MAX_OUTPUT_TOKENS,
    Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_OUTPUT_TOKENS,
  );
};

/**
 * Escolhe o que vai ao Provedor: normaliza papéis, tira Anexos e resultados
 * antigos que passam dos tetos da API e, se os tokens ainda passam do
 * orçamento, corta turnos do meio. O corte é por turno da pessoa, antes de
 * desdobrar as Rodadas, para uma Rodada nunca ficar pela metade. Não lê
 * bytes; `toChatRequest` lê só os Anexos que ficaram.
 */
export const selectHistory = ({
  messages,
  model,
  effort,
  estimator,
  toolSpace,
}: SelectHistoryInput): SelectedHistory => {
  const tools = toolSpace !== null;
  const candidates: SelectedMessage[] = messages
    .filter((message) => message.status !== 'streaming')
    .map(
      (message): SelectedMessage => ({
        role: message.role,
        parts: outgoingParts(
          message,
          tools && message.role === 'assistant' && message.provider === model.provider,
        ),
      }),
    )
    .filter((message) => message.parts.length > 0);

  let normalized = mergeAdjacent(candidates);

  // Após mergeAdjacent os papéis alternam: sobra no máximo uma ponta de assistant de cada lado.
  if (normalized[0]?.role === 'assistant') normalized = normalized.slice(1);
  if (normalized[normalized.length - 1]?.role === 'assistant') normalized = normalized.slice(0, -1);

  if (normalized.length === 0) {
    throw new Error('selectHistory precisa terminar com uma Mensagem do user.');
  }

  const maxTokens = outputTokensOf(model);
  const maxInputTokens = model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  // As Rodadas do turno crescem a requisição depois do corte: o espaço delas sai do orçamento,
  // sem passar da metade, para o histórico nunca ficar sem lugar.
  const contextBudget = Math.floor(maxInputTokens * CONTEXT_BUDGET);
  const space = toolSpace === null ? null : Math.min(toolSpace, Math.floor(contextBudget / 2));
  const budget = Math.max(1, contextBudget - (space ?? 0));

  const { turns, attachments, results } = elideOlder(
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

  return {
    model: model.id,
    maxTokens,
    effort,
    toolSpace: space,
    messages: unfold(selected),
    truncated:
      cutTurns || attachments || results ? { turns: cutTurns, attachments, results } : null,
  };
};

/** Busca os Blobs dos Anexos que ficaram na seleção e monta a requisição da porta. */
export const toChatRequest = async (
  selected: SelectedHistory,
  readAttachments: (ids: AttachmentId[]) => Promise<Blob[]>,
  tools: ToolDefinition[],
): Promise<ChatRequest> => {
  const ids = selected.messages.flatMap(({ parts }) =>
    parts.flatMap((part) => (part.type === 'file' ? [part.attachment.id] : [])),
  );
  const blobs = await readAttachments(ids);
  const data = new Map(ids.map((id, index) => [id, blobs[index]!]));

  return {
    model: selected.model,
    maxTokens: selected.maxTokens,
    effort: selected.effort,
    tools,
    messages: selected.messages.map((message) => ({
      role: message.role,
      parts: message.parts.map((part): OutgoingPart => {
        switch (part.type) {
          case 'file':
            return { ...part, data: data.get(part.attachment.id)! };
          case 'tool_result': {
            // As Fontes servem só ao marcador; não vão ao Provedor.
            const { sources, ...outgoing } = part;
            return outgoing;
          }
          default:
            return part;
        }
      }),
    })),
  };
};

/**
 * As Rodadas já fechadas da resposta em curso, para seguirem a requisição do
 * turno. Aqui o raciocínio volta, com a `signature`: o Provedor exige o da
 * resposta que pediu Ferramentas.
 */
export const continuationOf = (parts: Part[]): ChatMessage[] =>
  alternate(
    parts.flatMap((part): OutgoingPart[] => {
      switch (part.type) {
        case 'tool_result':
          return [outgoingResult(part)];
        case 'text':
          return part.text.trim() === '' ? [] : [{ type: 'text', text: part.text }];
        case 'file':
          return [];
        default:
          return [part];
      }
    }),
  );

/**
 * Quanto as Rodadas fechadas da resposta em curso pesam na próxima
 * requisição. A saída do Modelo conta pelo uso que o Provedor informou, porque
 * o raciocínio volta inteiro mesmo quando o texto dele chega vazio; sem uso
 * informado, pela estimativa das Partes. Os resultados contam pela estimativa.
 */
export const roundsTokens = (
  parts: Part[],
  outputTokens: number | null,
  estimator: TokenEstimator,
): number => {
  const sent = continuationOf(parts).flatMap((message) => message.parts);
  const tokens = (kept: OutgoingPart[]): number =>
    kept.reduce((sum, part) => sum + estimator.estimate(textIn(part)), 0);
  const results = tokens(sent.filter((part) => part.type === 'tool_result'));
  const output =
    outputTokens === null ? tokens(sent.filter((part) => part.type !== 'tool_result')) : outputTokens;
  return output + results;
};
