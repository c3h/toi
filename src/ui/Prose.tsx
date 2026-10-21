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
}

const Block = memo(({ text, closed }: BlockProps) => (
  <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
    <Markdown text={text} closed={closed} />
  </Suspense>
));

interface ProseProps {
  text: string;
  streaming: boolean;
}

/**
 * Resposta em Markdown. Blocos fechados ficam memoizados; durante o Fluxo só
 * o último é reprocessado. O cursor fica no fim do último elemento.
 */
export const Prose = memo(({ text, streaming }: ProseProps) => {
  const blocks = useMemo(() => splitBlocks(text), [text]);

  return (
    <div className="prose-reply">
      {blocks.map((block, index) => (
        <Block key={index} text={block} closed={!streaming || index < blocks.length - 1} />
      ))}
      {streaming && <span className="caret" aria-hidden="true" />}
    </div>
  );
});
