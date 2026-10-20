import type { PartKind } from './message';
import type { StopReason, Usage } from './usage';

export type StreamEvent =
  | { type: 'started'; model: string; usage: Usage }
  | { type: 'part_started'; index: number; part: PartKind }
  | { type: 'delta'; index: number; part: PartKind; text: string }
  | { type: 'part_finished'; index: number }
  | { type: 'usage'; usage: Usage; stopReason: StopReason }
  | { type: 'finished' };
