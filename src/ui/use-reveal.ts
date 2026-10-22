import { useEffect, useLayoutEffect, useState } from 'react';
import type { MessageStatus } from '../domain/message';
import {
  advanceReveal,
  isRevealSettled,
  retargetReveal,
  revealedText,
  startRevealTrack,
  type RevealIntent,
  type RevealTrack,
} from './reveal';

// Uma lista para todas as respostas: o histórico monta uma por Mensagem.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Com o Fluxo aberto, o cursor aparece depois de o texto ficar parado este
// tanto. Bem acima da sobra de silêncio entre rajadas que a revelação não
// cobre, para ele não piscar no meio do texto.
const WAIT_MS = 400;

const intentOf = (status: MessageStatus): RevealIntent =>
  status === 'streaming' ? 'live' : status === 'complete' ? 'settle' : 'instant';

export interface Reveal {
  /** O prefixo do texto que já está à vista. */
  shown: string;
  /** Em Fluxo ou ainda drenando: a resposta ainda não está inteira na tela. */
  revealing: boolean;
  /**
   * Fluxo aberto e nada correndo: antes do primeiro token ou parado há
   * WAIT_MS. Enquanto o texto corre, a entrada das palavras já marca onde ele
   * está, e um cursor junto só cansa a vista.
   */
  waiting: boolean;
  /**
   * Esta tela viu a resposta em Fluxo: as palavras entram com animação. Fica
   * ligado até desmontar: desligar ao fechar re-renderizaria todos os blocos e
   * cortaria a entrada da última palavra.
   */
  animate: boolean;
}

interface RevealLoop {
  track: RevealTrack;
  /** O trecho de texto que a faixa revela. */
  segment: number;
  latest: { text: string; intent: RevealIntent };
  frame: number;
  lastFrameAt: number;
}

/** Fora do hook: vive com a Mensagem e prende só o loop e o setter, não o escopo de um render. */
const retargetOf = (reveal: RevealLoop, setShown: (shown: string) => void) => (): void => {
  const { text, intent } = reveal.latest;
  const animate = !document.hidden && !reducedMotion.matches;
  reveal.track = retargetReveal(reveal.track, text, intent, animate);
  setShown(revealedText(reveal.track));
  if (reveal.frame !== 0 || isRevealSettled(reveal.track.state, text.length)) return;

  const tick = (now: number) => {
    reveal.track = advanceReveal(reveal.track, now - reveal.lastFrameAt);
    reveal.lastFrameAt = now;
    setShown(revealedText(reveal.track));
    reveal.frame = isRevealSettled(reveal.track.state, reveal.track.text.length)
      ? 0
      : requestAnimationFrame(tick);
  };
  reveal.lastFrameAt = performance.now();
  reveal.frame = requestAnimationFrame(tick);
};

/**
 * Texto da Mensagem do assistant no ritmo de `ui/reveal.ts`. Um loop de rAF
 * por Mensagem enquanto há o que revelar; texto novo reaponta o loop, não o
 * reinicia, para não perder tempo de frame entre deltas. `segment` é o trecho
 * de texto em curso: uma chamada de Ferramenta fecha o trecho, e o seguinte
 * recomeça do vazio, como uma resposta nova.
 */
export const useReveal = (text: string, status: MessageStatus, segment: number): Reveal => {
  const intent = intentOf(status);
  // Criado uma vez, não por render: quem usa re-renderiza a cada frame.
  const [reveal] = useState<RevealLoop>(() => ({
    track: startRevealTrack(text, intent),
    segment,
    latest: { text, intent },
    frame: 0,
    lastFrameAt: 0,
  }));
  const [shown, setShown] = useState(() => revealedText(reveal.track));
  const [retarget] = useState(() => retargetOf(reveal, setShown));

  const [animate, setAnimate] = useState(intent === 'live');
  if (intent === 'live' && !animate) setAnimate(true);

  // Antes do paint, para uma resposta inteira nunca piscar vazia.
  useLayoutEffect(() => {
    if (reveal.segment !== segment) {
      reveal.segment = segment;
      reveal.track = retargetReveal(reveal.track, '', intent, true);
    }
    reveal.latest = { text, intent };
    retarget();
  }, [text, intent, segment, reveal, retarget]);

  const revealing = intent === 'live' || shown.length < text.length;
  const idle = intent === 'live' && shown.length === text.length;

  // O texto à vista quando parou. Voltando a correr, ele difere do atual e o
  // cursor some no mesmo render, sem esperar um efeito. Enquanto o texto corre
  // a dependência fica `null` e o efeito não roda a cada frame.
  const idleText = idle ? shown : null;
  const [stalled, setStalled] = useState<string | null>(null);
  useEffect(() => {
    if (idleText === null || idleText === '') return;
    const timer = setTimeout(() => setStalled(idleText), WAIT_MS);
    return () => clearTimeout(timer);
  }, [idleText]);
  const waiting = idle && (shown === '' || shown === stalled);

  // Aba oculta ou movimento reduzido mostram tudo de uma vez, mesmo sem texto
  // novo. Só escuta enquanto revela: o histórico tem uma Mensagem por resposta.
  useLayoutEffect(() => {
    if (!revealing) return;
    document.addEventListener('visibilitychange', retarget);
    reducedMotion.addEventListener('change', retarget);
    return () => {
      document.removeEventListener('visibilitychange', retarget);
      reducedMotion.removeEventListener('change', retarget);
    };
  }, [revealing, retarget]);

  useLayoutEffect(
    () => () => {
      cancelAnimationFrame(reveal.frame);
      reveal.frame = 0;
    },
    [reveal],
  );

  return { shown, revealing, waiting, animate };
};
