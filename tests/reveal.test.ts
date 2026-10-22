import { describe, expect, it } from 'vitest';
import {
  advanceReveal,
  initialRevealState,
  isRevealSettled,
  retargetReveal,
  revealedPrefix,
  revealedText,
  startRevealTrack,
  stepReveal,
  type RevealState,
} from '../src/ui/reveal';

/** [ms depois do pedido, caracteres] por delta, como o Provedor entrega. */
type Trace = [number, number][];

interface Frame {
  at: number;
  arrived: number;
  shown: number;
}

// O fim do Fluxo chega este tanto depois do último delta.
const COMPLETION_MS = 100;
const FRAME_MS = 1000 / 60;

/** Toca o trace na revelação a uma taxa fixa de frames, como o rAF, até tudo estar à vista. */
const play = (trace: Trace, frameMs = FRAME_MS): Frame[] => {
  const frames: Frame[] = [];
  const end = trace[trace.length - 1]![0] + COMPLETION_MS;
  let state: RevealState = initialRevealState;
  let arrived = 0;
  let next = 0;

  for (let at = trace[0]![0]; ; at += frameMs) {
    while (next < trace.length && trace[next]![0] <= at) arrived += trace[next++]![1];
    state = stepReveal(state, arrived, at < end ? 'live' : 'drain', frameMs);
    frames.push({ at, arrived, shown: Math.floor(state.shown) });
    if (next === trace.length && isRevealSettled(state, arrived)) return frames;
    if (at > end + 10_000) throw new Error('A revelação nunca assentou.');
  }
};

const perFrame = (frames: Frame[]): number[] =>
  frames.map((frame, index) => frame.shown - (frames[index - 1]?.shown ?? 0));

/**
 * Maior sequência de frames sem mostrar nada enquanto havia texto esperando,
 * depois dos `skipMs` iniciais (o primeiro token chega sozinho, antes de haver taxa).
 */
const longestFreezeMs = (frames: Frame[], skipMs: number): number => {
  let longest = 0;
  let run = 0;
  const steps = perFrame(frames);
  frames.forEach((frame, index) => {
    if (frame.at - frames[0]!.at < skipMs || frame.shown >= frame.arrived) return;
    run = steps[index] === 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  });
  return longest * FRAME_MS;
};

// Upstream ruim: ~180 caracteres a cada ~290 ms, nada no meio.
const clumped: Trace = [
  [800, 2],
  ...Array.from({ length: 12 }, (_, i) => [1080 + i * 290, 180] as [number, number]),
];

// Haiku: primeiro token sozinho, ~200 ms de silêncio, um monte de deltas no
// mesmo pacote, depois ~15 caracteres a cada 20 ms com um silêncio de 150 ms
// seguido de outro monte.
const haiku: Trace = [
  [620, 1],
  [815, 110],
  ...Array.from({ length: 40 }, (_, i) => [835 + i * 20, 15] as [number, number]),
  [1785, 120],
  ...Array.from({ length: 40 }, (_, i) => [1805 + i * 20, 15] as [number, number]),
];

describe('stepReveal', () => {
  it('espalha as rajadas pelo silêncio entre elas em vez de mostrar frases inteiras', () => {
    for (const trace of [clumped, haiku]) {
      const frames = play(trace);
      expect(Math.max(...perFrame(frames))).toBeLessThanOrEqual(20);
      expect(longestFreezeMs(frames, 400)).toBe(0);
    }
  });

  it('salta à frente de um texto que chega inteiro e anima só o fim', () => {
    const frames = play([
      [0, 3000],
      [50, 1],
    ]);
    expect(frames[0]!.shown).toBeGreaterThanOrEqual(3000 - 400 * 0.25);
    expect(frames[frames.length - 1]!.at).toBeLessThanOrEqual(500);
  });

  it('corre cerca de um quarto de segundo atrás da chegada', () => {
    const frames = play(haiku);
    let arrived = 0;
    const arrivals = haiku.map(([at, chars]) => ({ at, upTo: (arrived += chars) }));
    const lags: number[] = [];
    let index = 0;

    for (const frame of frames) {
      while (arrivals[index] && arrivals[index]!.upTo <= frame.shown) {
        lags.push(frame.at - arrivals[index]!.at);
        index++;
      }
    }

    lags.sort((a, b) => a - b);
    expect(lags[Math.floor(lags.length * 0.95)]).toBeLessThanOrEqual(350);
  });

  it('mostra o que falta em até 400 ms depois do fim do Fluxo', () => {
    for (const trace of [clumped, haiku]) {
      const frames = play(trace);
      const completedAt = trace[trace.length - 1]![0] + COMPLETION_MS;
      expect(frames[frames.length - 1]!.at - completedAt).toBeLessThanOrEqual(400 + FRAME_MS);
    }
  });

  it('tem o mesmo ritmo a 60 e a 120 frames por segundo', () => {
    const at60 = play(clumped, 1000 / 60);
    const at120 = play(clumped, 1000 / 120);
    const shownBy = (frames: Frame[], at: number) =>
      [...frames].reverse().find((frame) => frame.at <= at)!.shown;

    for (let at = 1200; at < 4500; at += 250) {
      expect(Math.abs(shownBy(at60, at) - shownBy(at120, at))).toBeLessThanOrEqual(25);
    }
  });
});

describe('revealedPrefix', () => {
  it('nunca mostra meio caractere', () => {
    expect(revealedPrefix('a😀b', 2)).toBe('a😀');
    expect(revealedPrefix('a😀b', 3)).toBe('a😀');
    expect(revealedPrefix('café noir', 4)).toBe('café');
    expect(revealedPrefix('x👩‍👧!', 3)).toBe('x👩‍👧');
    expect(revealedPrefix('🇧🇷!', 1)).toBe('🇧🇷');
  });
});

describe('retargetReveal', () => {
  const settledLive = (text: string) => {
    let track = retargetReveal(startRevealTrack('', 'live'), text, 'live', true);
    while (!isRevealSettled(track.state, track.text.length)) {
      track = advanceReveal(track, FRAME_MS);
    }
    return track;
  };

  it('mostra inteira a Mensagem aberta do histórico', () => {
    const track = retargetReveal(startRevealTrack('Olá mundo', 'settle'), 'Olá mundo', 'settle', true);
    expect(track.mode).toBe('instant');
    expect(revealedText(track)).toBe('Olá mundo');
  });

  it('recomeça do zero ao tentar de novo, que limpa as Partes', () => {
    const track = retargetReveal(settledLive('Primeira resposta.'), '', 'live', true);
    expect(track.state).toEqual(initialRevealState);
    expect(revealedText(track)).toBe('');
  });

  it('mostra tudo com a aba oculta ou movimento reduzido e continua dali', () => {
    let track = retargetReveal(startRevealTrack('', 'live'), 'Texto que chegou', 'live', true);
    track = retargetReveal(track, 'Texto que chegou', 'live', false);
    expect(revealedText(track)).toBe('Texto que chegou');

    track = retargetReveal(track, 'Texto que chegou agora', 'live', true);
    expect(track.mode).toBe('live');
    expect(revealedText(track)).toBe('Texto que chegou');
  });
});
