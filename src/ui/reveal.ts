// Revelação do texto em Fluxo. O Provedor entrega em rajadas: um primeiro
// token sozinho, depois um monte de deltas após 150–330 ms de silêncio (medido
// no tomo com Haiku, 2026-10). Mostrado cru, isso vira travada seguida de
// frase inteira. A revelação corre um pouco atrás do que chegou, na velocidade
// em que chega, e espalha cada rajada pelo silêncio que a precedeu.

// Quanto a revelação fica atrás da chegada em regime: o bastante para cobrir o
// silêncio típico, pouco o bastante para o texto parecer vivo.
const LAG_S = 0.25;
// Quão rápido a velocidade segue a taxa de chegada; evita solavanco a cada rajada.
const SPEED_TAU_S = 0.4;
// Mais de cerca de um segundo pendente (um delta enorme, a Conversa reaberta no
// meio do Fluxo) salta à frente: só os últimos LAG_S são animados.
const MAX_LAG_S = 1;
// Taxa suposta antes de haver uma, para esse salto. Provedores medidos chegam
// a 500–1200 caracteres por segundo.
const NOMINAL_CPS = 400;
// Fechada a resposta, o que falta aparece dentro deste prazo.
const DRAIN_S = 0.4;
// Piso, para um gotejar nunca rastejar. Velocidade no piso não é medida, então
// a próxima rajada semeia a velocidade de novo.
const MIN_CPS = 60;
// Frame longo (main thread ocupada) avança pela duração real até este teto;
// além dele, quem alcança é o limite de atraso, não um salto.
const MAX_FRAME_S = 0.25;

/** `live`: o texto ainda chega. `drain`: chegou tudo, termina o pendente. `instant`: mostra tudo já. */
export type RevealMode = 'live' | 'drain' | 'instant';

export interface RevealState {
  /** Caracteres à vista, fracionário entre frames. */
  shown: number;
  /** Caracteres por segundo; no máximo MIN_CPS até chegar a primeira rajada. */
  speed: number;
}

export const initialRevealState: RevealState = { shown: 0, speed: 0 };

export const stepReveal = (
  state: RevealState,
  targetLength: number,
  mode: RevealMode,
  elapsedMs: number,
): RevealState => {
  // Nada pendente: guarda a velocidade, para o texto depois de uma pausa
  // voltar no ritmo em que chegava em vez de acelerar do zero.
  if (mode === 'instant' || targetLength <= state.shown) {
    return { shown: targetLength, speed: state.speed };
  }

  const reference = Math.max(state.speed, NOMINAL_CPS);
  const shown =
    targetLength - state.shown > reference * MAX_LAG_S
      ? targetLength - reference * LAG_S
      : state.shown;
  const backlog = targetLength - shown;
  const dt = Math.min(Math.max(elapsedMs, 0) / 1000, MAX_FRAME_S);
  const desired = backlog / LAG_S;
  const eased =
    state.speed <= MIN_CPS
      ? desired
      : state.speed + (desired - state.speed) * Math.min(1, dt / SPEED_TAU_S);
  const speed = Math.max(
    eased,
    MIN_CPS,
    backlog / MAX_LAG_S,
    mode === 'drain' ? backlog / DRAIN_S : 0,
  );

  return { shown: Math.min(targetLength, shown + speed * dt), speed };
};

export const isRevealSettled = (state: RevealState, targetLength: number): boolean =>
  state.shown >= targetLength;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * O prefixo de `text` com `shown` caracteres, estendido até o fim do grafema
 * em que o corte cai: nenhum caractere aparece pela metade (par substituto,
 * acento combinante, emoji unido, bandeira).
 */
export const revealedPrefix = (text: string, shown: number): string => {
  const end = Math.min(text.length, Math.floor(shown));
  if (end === 0 || end === text.length) return text.slice(0, end);

  const grapheme = GRAPHEMES.segment(text).containing(end - 1)!;
  return text.slice(0, grapheme.index + grapheme.segment.length);
};

/**
 * `live`: a Mensagem está em Fluxo. `settle`: fechou `complete`, então uma
 * revelação em curso termina. `instant`: o resto (Mensagem aberta do
 * histórico, `interrupted`, `failed`) aparece inteiro.
 */
export type RevealIntent = 'live' | 'settle' | 'instant';

export interface RevealTrack {
  state: RevealState;
  text: string;
  mode: RevealMode;
}

export const startRevealTrack = (text: string, intent: RevealIntent): RevealTrack =>
  intent === 'live'
    ? { state: initialRevealState, text: '', mode: 'live' }
    : { state: { shown: text.length, speed: 0 }, text, mode: 'instant' };

/** O que está à vista da faixa. */
export const revealedText = (track: RevealTrack): string =>
  revealedPrefix(track.text, track.state.shown);

/** Se há animação em curso, para o fechamento drenar em vez de saltar. */
const isAnimating = (track: RevealTrack): boolean =>
  track.mode === 'live' ||
  (track.mode === 'drain' && !isRevealSettled(track.state, track.text.length));

/**
 * Aponta a revelação para o texto novo. `animate` é falso com a aba oculta ou
 * quando a pessoa pediu movimento reduzido.
 */
export const retargetReveal = (
  track: RevealTrack,
  text: string,
  intent: RevealIntent,
  animate: boolean,
): RevealTrack => {
  const revealing = intent === 'live' || (intent === 'settle' && isAnimating(track));
  const mode: RevealMode =
    !animate || !revealing ? 'instant' : intent === 'live' ? 'live' : 'drain';
  const { speed } = track.state;
  let state = track.state;

  // Toda resposta começa de texto vazio, então texto vazio é uma resposta nova
  // (tentar de novo limpa as Partes).
  if (text === '') state = initialRevealState;
  else if (mode === 'instant') state = { shown: text.length, speed };
  // Texto que não estende o que está à vista: em Fluxo, o store trouxe o que
  // esta tela perdeu, e a revelação fica onde estava; fechada a resposta, o
  // texto final difere e aparece inteiro.
  else if (!text.startsWith(revealedText(track))) {
    state = { shown: mode === 'live' ? Math.min(state.shown, text.length) : text.length, speed };
  }

  return { state, text, mode };
};

/** Avança um frame de animação. */
export const advanceReveal = (track: RevealTrack, elapsedMs: number): RevealTrack => ({
  ...track,
  state: stepReveal(track.state, track.text.length, track.mode, elapsedMs),
});
