import type { Element, ElementContent } from 'hast';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

const components = (closed: boolean): Components => ({
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

interface MarkdownProps {
  text: string;
  closed: boolean;
}

export default function Markdown({ text, closed }: MarkdownProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={closed ? CLOSED : OPEN}>
      {text}
    </ReactMarkdown>
  );
}
