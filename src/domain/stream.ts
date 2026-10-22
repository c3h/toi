import type { StopReason, Usage } from './usage';

/** A Parte que um bloco do Provedor abre; o que ela precisa saber desde o início. */
export type PartStart =
  | { type: 'text' }
  | { type: 'reasoning' }
  /** Raciocínio cifrado pelo Provedor: chega inteiro, sem delta. */
  | { type: 'redacted_reasoning'; data: string }
  | { type: 'tool_call'; callId: string; tool: string };

/**
 * O que um `delta` acrescenta ao bloco: texto da resposta, texto do
 * raciocínio, a `signature` do raciocínio ou um pedaço do JSON do input de
 * uma Ferramenta.
 */
export type DeltaKind = 'text' | 'reasoning' | 'signature' | 'input';

/** `index` é o bloco dentro de uma Rodada; cada Rodada recomeça a contagem. */
export type StreamEvent =
  | { type: 'started'; model: string; usage: Usage }
  | { type: 'part_started'; index: number; part: PartStart }
  | { type: 'delta'; index: number; part: DeltaKind; text: string }
  | { type: 'part_finished'; index: number }
  | { type: 'usage'; usage: Usage; stopReason: StopReason }
  | { type: 'finished' };
