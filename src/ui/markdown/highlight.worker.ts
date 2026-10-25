import { createHighlighterCore, type LanguageInput } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import githubDarkDimmed from 'shiki/themes/github-dark-dimmed.mjs';
import githubLight from 'shiki/themes/github-light.mjs';
import type { HighlightReply, HighlightRequest, Token } from './highlight';
import type { Language } from './languages';

const THEMES = { light: 'github-light', dark: 'github-dark-dimmed' } as const;

/** A gramática de cada linguagem da lista, num chunk próprio. */
const GRAMMARS: Record<Language, LanguageInput> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  shellsession: () => import('shiki/langs/shellsession.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  terraform: () => import('shiki/langs/terraform.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  r: () => import('shiki/langs/r.mjs'),
};

const highlighter = createHighlighterCore({
  themes: [githubLight, githubDarkDimmed],
  langs: [],
  // Engine em JavaScript: sem wasm no bundle. `forgiving` ignora o raro regex que ele não suporta.
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});
const loading = new Map<Language, Promise<void>>();

/** Tokens com as cores dos dois temas em variáveis. */
const tokensOf = async ({ code, lang }: HighlightRequest): Promise<Token[][]> => {
  const core = await highlighter;
  if (!loading.has(lang)) loading.set(lang, core.loadLanguage(GRAMMARS[lang]));
  await loading.get(lang);

  const { tokens } = core.codeToTokens(code, { lang, themes: THEMES, defaultColor: false });
  // Só o que a tela usa atravessa para a main thread.
  return tokens.map((line) => line.map(({ content, htmlStyle }) => ({ content, htmlStyle })));
};

// Cada pedido por conta própria: um bloco de gramática já carregada não espera outra baixar, e a
// tokenização, síncrona, sai em série de qualquer jeito. A gramática que não baixa falha só os
// pedidos dela.
self.addEventListener('message', ({ data }: MessageEvent<HighlightRequest>) => {
  const reply = (tokens: Token[][] | null) =>
    self.postMessage({ id: data.id, tokens } satisfies HighlightReply);
  tokensOf(data).then(reply, () => reply(null));
});
