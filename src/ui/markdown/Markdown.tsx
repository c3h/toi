import type { Element, ElementContent, Root } from 'hast';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remend from 'remend';
import { CodeBlock } from './CodeBlock';

const textOf = (nodes: ElementContent[]): string =>
  nodes
    .map((node) => ('value' in node ? node.value : 'children' in node ? textOf(node.children) : ''))
    .join('');

const languageOf = (code: Element): string | null => {
  const classes = code.properties.className;
  if (!Array.isArray(classes)) return null;
  const match = classes.map(String).find((name) => name.startsWith('language-'));
  return match ? match.slice('language-'.length) : null;
};

// Os mesmos nos dois conjuntos: trocar de componente ao fechar o bloco remontaria o link e repetiria a entrada das palavras.
const shared: Components = {
  // Sem `rehype-raw`: HTML da resposta nunca vira DOM.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Imagem buscaria um host de terceiro; a CSP bloquearia de qualquer jeito.
  img: ({ alt, src }) => (
    <span className="font-mono text-sm text-subtle">[imagem: {alt || src}]</span>
  ),
};

const components = (closed: boolean): Components => ({
  ...shared,
  pre: ({ node }) => {
    const code = node?.children.find(
      (child): child is Element => child.type === 'element' && child.tagName === 'code',
    );
    if (!code) return null;
    return (
      <CodeBlock
        code={textOf(code.children).replace(/\n$/, '')}
        lang={languageOf(code)}
        closed={closed}
      />
    );
  },
});

const OPEN = components(false);
const CLOSED = components(true);

/**
 * Fecha o que o Fluxo ainda não fechou (`**neg`, `` `cód``, `[link](htt`) para
 * o bloco aparecer como vai ficar. Fica de fora o que mudaria a leitura do
 * texto fechado: este Markdown não tem KaTeX, e `~` e `>` seguem o GFM.
 */
const heal = (text: string): string =>
  remend(text, {
    linkMode: 'text-only',
    katex: false,
    singleTilde: false,
    comparisonOperators: false,
  });

const PIECES = /\S+|\s+/g;

/**
 * Cada palavra num `span.word`. As chaves do react-markdown são por posição,
 * então o texto que cresce mantém os `span` que já estavam e só os novos
 * montam, com a animação de entrada. Código inline entra inteiro; bloco de
 * código não anima.
 */
const wrapWords = (parent: Root | Element): void => {
  parent.children = (parent.children as ElementContent[]).flatMap((child): ElementContent[] => {
    if (child.type === 'text') {
      return (child.value.match(PIECES) ?? []).map((piece) =>
        /\s/.test(piece)
          ? { type: 'text', value: piece }
          : {
              type: 'element',
              tagName: 'span',
              properties: { className: ['word'] },
              children: [{ type: 'text', value: piece }],
            },
      );
    }

    if (child.type === 'element' && child.tagName === 'code') {
      child.properties.className = ['word'];
    } else if (child.type === 'element' && child.tagName !== 'pre') {
      wrapWords(child);
    }

    return [child];
  });
};

const WORDS = [() => wrapWords];

interface MarkdownProps {
  text: string;
  closed: boolean;
  /** Palavras entram com animação; só na resposta que esta tela viu chegar. */
  animate: boolean;
}

export default function Markdown({ text, closed, animate }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={animate ? WORDS : undefined}
      components={closed ? CLOSED : OPEN}
    >
      {closed ? text : heal(text)}
    </ReactMarkdown>
  );
}
