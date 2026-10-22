import {
  appError,
  asAppError,
  isAbortError,
  toErrorInfo,
  type AppError,
  type AppErrorCode,
} from '../domain/error';
import type { ToolCallPart, ToolResultPart } from '../domain/message';
import {
  canonicalUrl,
  DEFAULT_TOOL_SPACE,
  hostOf,
  WEB_FETCH,
  WEB_SEARCH,
  type FetchFailure,
  type FetchFailureCode,
  type Source,
  type ToolSpace,
} from '../domain/web';
import type { ToolDefinition } from '../ports/chat-provider';
import type { Clock } from '../ports/clock';
import type { SettingsStore } from '../ports/settings-store';
import type { TokenEstimator } from '../ports/token-estimator';
import type { FetchOutcome, SearchOutcome, WebTools } from '../ports/web-tools';

/** Caracteres de um resultado entregue ao Modelo; uma Leitura divide entre as páginas. */
export const MAX_RESULT_CHARS = 15_000;
/** Chamadas de Ferramenta numa resposta; as excedentes recebem `tool_call_limit` sem rede. */
export const MAX_TOOL_CALLS_PER_TURN = 10;
/**
 * Idas ao Provedor numa resposta; a última que ainda pede Ferramenta fecha em
 * `tool_limit`, como a que pede depois de as Rodadas encherem o espaço.
 */
export const MAX_ROUNDS = 12;
/** URLs por Leitura. */
export const MAX_FETCH_URLS = 3;

/** Idiomas que a Busca aceita no parâmetro `language`; o do navegador vira o default. */
export const SEARCH_LANGUAGES = [
  'ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'tr', 'zh',
] as const;

const isSearchLanguage = (value: string): boolean =>
  (SEARCH_LANGUAGES as readonly string[]).includes(value);

/** `pt-BR` → `pt`; fora da lista, inglês. */
export const searchLanguageOf = (locale: string): string => {
  const code = locale.toLowerCase().replace(/-.*/, '');
  return isSearchLanguage(code) ? code : 'en';
};

/** O espaço escolhido em Configurações; `DEFAULT_TOOL_SPACE` até a pessoa escolher. */
export const readToolSpace = async (settings: Pick<SettingsStore, 'toolSpace'>): Promise<ToolSpace> =>
  (await settings.toolSpace()) ?? DEFAULT_TOOL_SPACE;

/** O que um resultado no teto pesa: cada chamada só sai se ele ainda cabe no espaço. */
export const resultTokens = (estimator: TokenEstimator): number =>
  estimator.estimate('x'.repeat(MAX_RESULT_CHARS));

/**
 * As Ferramentas como o Modelo as vê. A data e o idioma são do início do
 * turno: a requisição de cada Rodada repete o mesmo prefixo.
 */
export const toolDefinitions = (today: string, language: string): ToolDefinition[] => [
  {
    name: WEB_SEARCH,
    description:
      `Search the web. Today is ${today}. Use it when the answer depends on current events, ` +
      'recent releases, prices, or facts you are unsure of; answer directly when you already know. ' +
      'Results are short snippets, not full pages. To read pages, call web_fetch with the URLs ' +
      'you need, all in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        language: {
          type: 'string',
          enum: [...SEARCH_LANGUAGES],
          description: `Language of the results. Defaults to "${language}".`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: WEB_FETCH,
    description:
      `Read up to ${MAX_FETCH_URLS} web pages as Markdown. Only URLs that already appear in this ` +
      'conversation are allowed: search results, pages read before, or URLs the user wrote. URLs ' +
      'inside attachments or in your own messages are refused. Long pages are cut.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_FETCH_URLS,
          description: 'Exact URLs to read.',
        },
      },
      required: ['urls'],
      additionalProperties: false,
    },
  },
];

type ToolRequest =
  | { tool: typeof WEB_SEARCH; query: string; language: string }
  | { tool: typeof WEB_FETCH; urls: string[] };

/** O input como o Modelo mandou; `null` quando não é o que a Ferramenta aceita. */
const requestOf = (call: ToolCallPart, defaultLanguage: string): ToolRequest | null => {
  const { input } = call;
  if (call.tool === WEB_SEARCH) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    // `language` é opcional no schema; ausente vale o do navegador.
    const language = input.language === undefined ? defaultLanguage : input.language;
    if (query === '' || typeof language !== 'string' || !isSearchLanguage(language)) return null;
    return { tool: WEB_SEARCH, query, language };
  }
  if (call.tool === WEB_FETCH) {
    const { urls } = input;
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_FETCH_URLS) return null;
    if (!urls.every((url): url is string => typeof url === 'string')) return null;
    return { tool: WEB_FETCH, urls };
  }
  return null;
};

/** Para o Modelo, em inglês, como a descrição das Ferramentas. */
const ERROR_HINTS: Partial<Record<AppErrorCode, string>> = {
  tool_invalid_credential: 'The web tools key was refused. Tell the user to check it in Settings.',
  tool_quota_exhausted: 'The daily web tools quota is used up. Answer without searching.',
  tool_rate_limited: 'Too many web requests right now. Answer with what you have.',
  tool_invalid_input: 'The request was invalid. Check the tool input and try again.',
  tool_forbidden: 'The web tools service refused this request.',
  tool_url_not_eligible:
    'None of these URLs appear in this conversation. Search first, or ask the user for the link.',
  tool_call_limit: 'The limit of tool calls for this answer was reached. Answer with what you have.',
  tool_unreachable: 'The web tools service could not be reached.',
  tool_bad_response: 'The web tools service sent an unreadable response.',
};

const FAILURE_HINTS: Record<FetchFailureCode, string> = {
  not_eligible: 'not in this conversation; refused without fetching',
  not_found: 'page not found',
  http_error: 'the site returned an error',
  unreachable: 'the site could not be reached',
  timeout: 'the page took too long to load',
  blocked: 'the site blocks automated access',
  login_required: 'the page requires login',
  empty: 'no readable text on the page',
  too_large: 'the document is too large',
  rejected: 'the URL was rejected',
  unknown: 'the page could not be read',
};

const errorContent = (code: AppErrorCode): string =>
  `Error: ${ERROR_HINTS[code] ?? 'The tool failed.'}`;

const cut = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit))}\n[truncated]`;

const searchContent = (query: string, outcome: SearchOutcome): string => {
  if (outcome.hits.length === 0) return `No results for "${query}".`;
  const lines = outcome.hits.map(
    (hit, index) =>
      `${index + 1}. ${hit.title}\nURL: ${hit.url}` +
      (hit.date ? `\nDate: ${hit.date}` : '') +
      (hit.snippet ? `\n${hit.snippet}` : ''),
  );
  return cut(
    `Results for "${query}" (snippets only; use web_fetch to read pages):\n\n${lines.join('\n\n')}`,
    MAX_RESULT_CHARS,
  );
};

const fetchContent = (outcome: FetchOutcome): string => {
  const failures = outcome.failures.map(
    ({ url, code }) => `Could not read ${url}: ${FAILURE_HINTS[code]}.`,
  );
  const reserved = failures.join('\n').length;
  const share = Math.floor((MAX_RESULT_CHARS - reserved) / Math.max(1, outcome.pages.length));
  const pages = outcome.pages.map((page) => {
    const head = `# ${page.title ?? hostOf(page.finalUrl)}\nURL: ${page.finalUrl}\n\n`;
    return head + cut(page.text, share - head.length - 20);
  });
  return [...pages, ...failures].join('\n\n');
};

const errorResult = (call: ToolCallPart, error: AppError): ToolResultPart => ({
  type: 'tool_result',
  callId: call.callId,
  content: errorContent(error.code),
  sources: [],
  failures: [],
  error: toErrorInfo(error),
});

/** Estado das Ferramentas num turno: quantas chamadas já saíram e até quando o Serviço pediu espera. */
export interface ToolTurn {
  tools: WebTools;
  clock: Clock;
  signal: AbortSignal;
  language: string;
  /** O espaço das Rodadas, em tokens, já limitado pelo orçamento do Modelo. */
  space: number;
  /** O que fica guardado no espaço para a Rodada que conclui: o `max_tokens` do envio. */
  conclusion: number;
  /** `resultTokens` do estimador do envio. */
  resultTokens: number;
  calls: number;
  /** Instante até o qual um 429 manda esperar; antes dele nenhuma chamada sai. */
  rateLimitedUntil: number | null;
}

const search = async (
  turn: ToolTurn,
  call: ToolCallPart,
  request: Extract<ToolRequest, { tool: typeof WEB_SEARCH }>,
): Promise<ToolResultPart> => {
  const outcome = await turn.tools.search(
    { text: request.query, language: request.language },
    turn.signal,
  );
  return {
    type: 'tool_result',
    callId: call.callId,
    content: searchContent(request.query, outcome),
    sources: outcome.hits.map(({ title, url }): Source => ({ title, url })),
    failures: [],
    error: null,
  };
};

const read = async (
  turn: ToolTurn,
  call: ToolCallPart,
  urls: string[],
  eligible: Set<string>,
): Promise<ToolResultPart> => {
  // Sai a forma que passou na comparação: sem fragmento e em `https`, nada que o Modelo
  // acrescentou à URL elegível. Repetidas viram uma.
  const allowed = new Set<string>();
  const refused = new Map<string, FetchFailure>();
  for (const url of urls) {
    const canonical = canonicalUrl(url);
    if (canonical !== null && eligible.has(canonical)) allowed.add(canonical);
    else refused.set(url, { url, code: 'not_eligible' });
  }
  if (allowed.size === 0) return errorResult(call, appError('tool_url_not_eligible'));

  const outcome = await turn.tools.fetch([...allowed], turn.signal);
  const failures = [...refused.values(), ...outcome.failures];
  return {
    type: 'tool_result',
    callId: call.callId,
    content: fetchContent({ pages: outcome.pages, failures }),
    sources: outcome.pages.map((page) => ({
      title: page.title ?? hostOf(page.finalUrl),
      url: page.finalUrl,
    })),
    failures,
    error: null,
  };
};

const runCall = async (
  turn: ToolTurn,
  call: ToolCallPart,
  eligible: Set<string>,
): Promise<ToolResultPart> => {
  const request = requestOf(call, turn.language);
  if (request === null) return errorResult(call, appError('tool_invalid_input'));

  if (turn.rateLimitedUntil !== null && turn.clock.now() < turn.rateLimitedUntil) {
    const retryAfterSeconds = Math.ceil((turn.rateLimitedUntil - turn.clock.now()) / 1000);
    return errorResult(call, appError('tool_rate_limited', { retryAfterSeconds }));
  }

  try {
    turn.signal.throwIfAborted();
    return request.tool === WEB_SEARCH
      ? await search(turn, call, request)
      : await read(turn, call, request.urls, eligible);
  } catch (cause) {
    if (turn.signal.aborted || isAbortError(cause)) throw cause;
    const error = asAppError(cause);
    if (error.code === 'tool_rate_limited' && error.retryAfterSeconds !== null) {
      turn.rateLimitedUntil = turn.clock.now() + error.retryAfterSeconds * 1000;
    }
    return errorResult(call, error);
  }
};

/**
 * Executa as chamadas de uma Rodada em paralelo e espera todas, mesmo depois
 * de um abort: o lock da Conversa só sai com nada correndo. As chamadas acima
 * do teto do turno, ou cujo resultado no teto não cabe no espaço que sobra
 * depois de `used` tokens das Rodadas e da Rodada que conclui, recebem
 * `tool_call_limit` sem rede; com `last` (a próxima Rodada é a última), todas
 * recebem, para o Modelo concluir com o que tem.
 * `eligible` é o conjunto do início da Rodada: uma Busca não autoriza uma
 * Leitura da mesma Rodada. Os resultados saem na ordem das chamadas.
 */
export const runCalls = async (
  turn: ToolTurn,
  calls: ToolCallPart[],
  eligible: Set<string>,
  used: number,
  last: boolean,
): Promise<ToolResultPart[]> => {
  const fit = Math.floor(Math.max(0, turn.space - used - turn.conclusion) / turn.resultTokens);
  const allowed = last ? 0 : Math.min(fit, Math.max(0, MAX_TOOL_CALLS_PER_TURN - turn.calls));
  turn.calls += calls.length;

  const settled = await Promise.allSettled(
    calls.map(async (call, index) =>
      index < allowed ? runCall(turn, call, eligible) : errorResult(call, appError('tool_call_limit')),
    ),
  );
  turn.signal.throwIfAborted();

  return settled.map((outcome) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    throw outcome.reason;
  });
};
