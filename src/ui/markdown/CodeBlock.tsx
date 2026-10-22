import { useEffect, useState, type CSSProperties } from 'react';
import type { ThemedToken } from 'shiki/core';
import { CopyButton } from '../CopyButton';

interface CodeBlockProps {
  code: string;
  lang: string | null;
  /** O highlight roda uma vez, quando o bloco fecha; nunca a cada delta. */
  closed: boolean;
}

export const CodeBlock = ({ code, lang, closed }: CodeBlockProps) => {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    if (!closed || !lang) return;
    let alive = true;
    // Shiki fica num chunk próprio: só baixa quando aparece o primeiro bloco de código fechado.
    import('./highlight')
      .then(({ highlight }) => highlight(code, lang))
      .then((result) => {
        if (alive) setTokens(result);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code, lang, closed]);

  return (
    <div className="code-block">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5 font-mono text-xs text-subtle">
        <span>{lang ?? 'texto'}</span>
        <CopyButton
          text={code}
          className="code-copy inline-flex items-center gap-1 px-1 hover:text-text"
        />
      </div>
      <pre>
        <code>
          {tokens
            ? tokens.map((line, index) => (
                <span key={index}>
                  {line.map((token, position) => (
                    <span
                      key={position}
                      className="token"
                      style={token.htmlStyle as CSSProperties | undefined}
                    >
                      {token.content}
                    </span>
                  ))}
                  {index < tokens.length - 1 && '\n'}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
};
