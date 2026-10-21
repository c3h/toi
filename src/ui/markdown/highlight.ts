import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';

const THEMES = { light: 'github-light', dark: 'github-dark-dimmed' } as const;

let highlighter: Promise<HighlighterCore> | null = null;
const loading = new Map<string, Promise<void>>();

const instance = (): Promise<HighlighterCore> =>
  (highlighter ??= createHighlighterCore({
    themes: [bundledThemes[THEMES.light](), bundledThemes[THEMES.dark]()],
    langs: [],
    // Engine em JavaScript: sem wasm no bundle. `forgiving` ignora o raro regex que ele não suporta.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));

const isBundled = (lang: string): lang is keyof typeof bundledLanguages => lang in bundledLanguages;

/** Tokens com as cores dos dois temas em variáveis; `null` para linguagem desconhecida. */
export const highlight = async (code: string, lang: string): Promise<ThemedToken[][] | null> => {
  const id = lang.toLowerCase();
  if (!isBundled(id)) return null;

  const core = await instance();
  if (!loading.has(id)) loading.set(id, core.loadLanguage(bundledLanguages[id]()));
  await loading.get(id);

  return core.codeToTokens(code, { lang: id, themes: THEMES, defaultColor: false }).tokens;
};
