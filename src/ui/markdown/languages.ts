/**
 * Linguagens com destaque: o nome da gramática no Shiki e os nomes que o fence
 * costuma usar. Fora da lista o bloco fica sem destaque, sem acordar o worker.
 */
const LANGUAGES = {
  javascript: ['js', 'cjs', 'mjs'],
  typescript: ['ts', 'cts', 'mts'],
  jsx: [],
  tsx: [],
  json: [],
  jsonc: [],
  html: [],
  css: [],
  scss: [],
  vue: [],
  svelte: [],
  shellscript: ['bash', 'sh', 'shell', 'zsh'],
  shellsession: ['console'],
  powershell: ['ps', 'ps1', 'pwsh'],
  bat: ['batch', 'cmd'],
  python: ['py'],
  sql: [],
  yaml: ['yml'],
  toml: [],
  ini: ['properties'],
  xml: [],
  markdown: ['md'],
  diff: [],
  docker: ['dockerfile'],
  make: ['makefile'],
  hcl: [],
  terraform: ['tf', 'tfvars'],
  graphql: ['gql'],
  go: [],
  rust: ['rs'],
  c: [],
  cpp: ['c++'],
  'objective-c': ['objc'],
  csharp: ['c#', 'cs'],
  java: [],
  kotlin: ['kt', 'kts'],
  scala: [],
  swift: [],
  dart: [],
  php: [],
  ruby: ['rb'],
  elixir: [],
  haskell: ['hs'],
  lua: [],
  r: [],
} as const satisfies Record<string, readonly string[]>;

export type Language = keyof typeof LANGUAGES;

const NAMES = new Map(
  Object.entries(LANGUAGES).flatMap(([name, aliases]) =>
    [name, ...aliases].map((alias) => [alias, name as Language] as const),
  ),
);

/** A gramática do nome que o fence usa; `null` fora da lista. */
export const languageOf = (lang: string): Language | null => NAMES.get(lang.toLowerCase()) ?? null;
