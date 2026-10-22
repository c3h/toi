import { lazy, memo, Suspense, useMemo } from 'react';
import { splitBlocks } from './blocks';

const loadMarkdown = () => import('./markdown/Markdown');
const Markdown = lazy(loadMarkdown);

/** Baixa o chunk de Markdown antes da primeira resposta, para ela não aparecer crua enquanto carrega. */
export const preloadMarkdown = (): void => {
  const load = () => void loadMarkdown().catch(() => undefined);
  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 2000 });
  else setTimeout(load, 200);
};

interface BlockProps {
  text: string;
  closed: boolean;
  animate: boolean;
}

const Block = memo(({ text, closed, animate }: BlockProps) => (
  <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
    <Markdown text={text} closed={closed} animate={animate} />
  </Suspense>
));

interface ProseProps {
  text: string;
  /** Em Fluxo ou ainda revelando: o último bloco segue aberto. */
  open: boolean;
  /** Palavras entram com animação: a resposta que esta tela viu chegar. */
  animate?: boolean;
  /** Mostra o cursor no fim do último elemento. */
  caret?: boolean;
}

/**
 * Resposta em Markdown. Blocos fechados ficam memoizados; durante o Fluxo só
 * o último é reprocessado.
 */
export const Prose = memo(({ text, open, animate = false, caret = false }: ProseProps) => {
  const blocks = useMemo(() => splitBlocks(text), [text]);

  return (
    <div className="prose-reply">
      {blocks.map((block, index) => (
        <Block
          key={index}
          text={block}
          closed={!open || index < blocks.length - 1}
          animate={animate}
        />
      ))}
      {caret && <span className="caret" aria-hidden="true" />}
    </div>
  );
});
