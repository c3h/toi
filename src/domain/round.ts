import { parseJsonObject, type JsonObject } from './json';
import { resultsByCall, type Message, type Part, type ToolCallPart } from './message';
import type { DeltaKind, StreamEvent } from './stream';

/**
 * Um bloco da Rodada em curso. Texto vira Parte a cada delta; raciocínio
 * espera a `signature` e a chamada de Ferramenta espera o JSON inteiro, porque
 * pela metade nenhum dos dois volta ao Provedor.
 */
type Block =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature: string; finished: boolean }
  | { type: 'redacted_reasoning'; data: string }
  | {
      type: 'tool_call';
      callId: string;
      tool: string;
      json: string;
      /** `null` antes do fim do bloco e quando o JSON não fecha num objeto. */
      input: JsonObject | null;
      finished: boolean;
    };

/** Uma ida e volta ao Provedor dentro da Mensagem. */
export interface Round {
  /** As Partes das Rodadas anteriores. */
  base: Part[];
  /** Pelo `index` do Evento; a ordem dos índices é a ordem das Partes. */
  blocks: ReadonlyMap<number, Block>;
}

export const startRound = (base: Part[]): Round => ({ base, blocks: new Map() });

const partOf = (block: Block): Part | null => {
  switch (block.type) {
    case 'text':
      return block.text === '' ? null : { type: 'text', text: block.text };
    case 'reasoning':
      return block.finished && block.signature !== ''
        ? { type: 'reasoning', text: block.text, signature: block.signature }
        : null;
    case 'redacted_reasoning':
      return { type: 'redacted_reasoning', data: block.data };
    case 'tool_call':
      return block.input === null
        ? null
        : { type: 'tool_call', callId: block.callId, tool: block.tool, input: block.input };
  }
};

const orderedBlocks = (round: Round): Block[] =>
  [...round.blocks].sort(([a], [b]) => a - b).map(([, block]) => block);

const partsOf = (round: Round): Part[] => [
  ...round.base,
  ...orderedBlocks(round).flatMap((block) => partOf(block) ?? []),
];

const startBlock = (event: Extract<StreamEvent, { type: 'part_started' }>): Block => {
  switch (event.part.type) {
    case 'text':
      return { type: 'text', text: '' };
    case 'reasoning':
      return { type: 'reasoning', text: '', signature: '', finished: false };
    case 'redacted_reasoning':
      return { type: 'redacted_reasoning', data: event.part.data };
    case 'tool_call':
      return {
        type: 'tool_call',
        callId: event.part.callId,
        tool: event.part.tool,
        json: '',
        input: null,
        finished: false,
      };
  }
};

const extend = (block: Block, kind: DeltaKind, text: string): Block => {
  if (block.type === 'text' && kind === 'text') return { ...block, text: block.text + text };
  if (block.type === 'reasoning' && kind === 'reasoning') return { ...block, text: block.text + text };
  if (block.type === 'reasoning' && kind === 'signature') {
    return { ...block, signature: block.signature + text };
  }
  if (block.type === 'tool_call' && kind === 'input' && !block.finished) {
    return { ...block, json: block.json + text };
  }
  return block;
};

const finish = (block: Block | undefined): Block | undefined => {
  if (block?.type === 'reasoning') return { ...block, finished: true };
  // Sem delta de input, o input é o objeto vazio do início do bloco.
  if (block?.type === 'tool_call' && !block.finished) {
    return { ...block, input: parseJsonObject(block.json || '{}'), finished: true };
  }
  return block;
};

const withBlock = (round: Round, index: number, block: Block | undefined): Round => {
  if (block === undefined || block === round.blocks.get(index)) return round;
  const blocks = new Map(round.blocks);
  blocks.set(index, block);
  return { ...round, blocks };
};

/**
 * Aplica um Evento de Parte à Mensagem em Fluxo. Aceita blocos em qualquer
 * ordem e intercalados; `started`, `usage` e `finished` são do laço da
 * resposta e passam sem mudar nada. O primeiro `delta` de qualquer Parte
 * encerra a espera.
 */
export const applyEvent = (
  message: Message,
  round: Round,
  event: StreamEvent,
  now: number,
): { message: Message; round: Round } => {
  let next = round;
  switch (event.type) {
    case 'part_started':
      next = withBlock(round, event.index, startBlock(event));
      break;
    case 'delta': {
      const block = round.blocks.get(event.index);
      // Delta só estende o bloco que um `part_started` abriu; fora dele, nada muda.
      if (block === undefined) return { message, round };
      next = withBlock(round, event.index, extend(block, event.part, event.text));
      break;
    }
    case 'part_finished':
      next = withBlock(round, event.index, finish(round.blocks.get(event.index)));
      break;
    default:
      return { message, round };
  }

  const timed =
    event.type === 'delta' && message.firstTokenAt === null ? { ...message, firstTokenAt: now } : message;
  // Raciocínio, `signature` e input só viram Parte quando o bloco fecha: até lá as Partes não mudam.
  if (next === round || (event.type === 'delta' && event.part !== 'text')) {
    return { message: timed, round: next };
  }
  return { message: { ...timed, parts: partsOf(next) }, round: next };
};

export interface RoundOutcome {
  /** As chamadas completas, na ordem em que vieram. */
  calls: ToolCallPart[];
  /** Alguma chamada não chegou ao fim ou trouxe JSON que não é objeto. */
  broken: boolean;
}

export const closeRound = (round: Round): RoundOutcome => {
  const calls = orderedBlocks(round).filter((block) => block.type === 'tool_call');
  return {
    calls: calls.flatMap((block) => {
      const part = partOf(block);
      return part?.type === 'tool_call' ? [part] : [];
    }),
    broken: calls.some((block) => block.input === null),
  };
};

/** Tira as chamadas sem resultado: a resposta fechou sem que o toi as executasse. */
export const withoutPendingCalls = (parts: Part[]): Part[] => {
  const results = resultsByCall(parts);
  return parts.filter((part) => part.type !== 'tool_call' || results.has(part.callId));
};
