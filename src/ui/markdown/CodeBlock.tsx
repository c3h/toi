import { useEffect, useState, type CSSProperties } from 'react';
import { CopyButton } from '../CopyButton';
import { highlight, type Token } from './highlight';
import { languageOf, type Language } from './languages';

interface CodeBlockProps {
  code: string;
  lang: string | null;
  /** O highlight roda uma vez, quando o bloco fecha; nunca a cada delta. */
  closed: boolean;
}

interface Highlighted {
  /** O que foi destacado: num bloco que muda (tentar de novo), tokens antigos não valem. */
  code: string;
  language: Language;
  /** `null`: sem destaque, para worker ou gramática que não baixam. */
  tokens: Token[][] | null;
}

export const CodeBlock = ({ code, lang, closed }: CodeBlockProps) => {
  const [highlighted, setHighlighted] = useState<Highlighted | null>(null);
  const language = lang === null ? null : languageOf(lang);

  useEffect(() => {
    if (!closed || language === null) return;
    let alive = true;
    // O worker do Shiki nasce no primeiro bloco fechado; até ele responder, o código fica cru.
    void highlight(code, language).then((tokens) => {
      if (alive) setHighlighted({ code, language, tokens });
    });
    return () => {
      alive = false;
    };
  }, [code, language, closed]);

  const current =
    highlighted !== null && highlighted.code === code && highlighted.language === language
      ? highlighted
      : null;
  const tokens = current === null ? null : current.tokens;

  return (
    <div className="code-block">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5 font-mono text-xs text-subtle">
        <span>{lang ?? 'texto'}</span>
        <CopyButton
          text={code}
          className="code-copy inline-flex items-center gap-1 px-1 hover:text-text"
        />
      </div>
      <pre aria-busy={closed && language !== null && current === null}>
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
