import type { Message, Part } from './message';

/** Os nomes das Ferramentas, gravados nas Partes `tool_call`. */
export const WEB_SEARCH = 'web_search';
export const WEB_FETCH = 'web_fetch';

/** O que uma Ferramenta achou ou leu: o título e onde. */
export interface Source {
  title: string;
  url: string;
}

/** Por que uma URL de uma Leitura não foi lida; as outras do lote seguem. */
export type FetchFailureCode =
  | 'not_eligible'
  | 'not_found'
  | 'http_error'
  | 'unreachable'
  | 'timeout'
  | 'blocked'
  | 'login_required'
  | 'empty'
  | 'too_large'
  | 'rejected'
  | 'unknown';

export interface FetchFailure {
  url: string;
  code: FetchFailureCode;
}

/**
 * Quanto as Rodadas de uma resposta podem somar à requisição, em tokens: os
 * resultados das Ferramentas e o que o Modelo escreve entre elas. Sai do
 * orçamento do histórico; a pessoa escolhe em Configurações.
 */
export const TOOL_SPACES = [20_000, 40_000, 80_000] as const;

export type ToolSpace = (typeof TOOL_SPACES)[number];

/**
 * Cabe uma pesquisa típica (duas Buscas e uma Leitura de três páginas) com o
 * raciocínio entre elas, e num Modelo de 200 mil sobram 120 mil ao histórico.
 */
export const DEFAULT_TOOL_SPACE: ToolSpace = 40_000;

/**
 * A forma comparável de uma URL: esquema e host como o parser deixa, porta
 * default e fragmento fora, path e query intactos. `http` e `https` da mesma
 * URL são a mesma. `null` para outro esquema e para credenciais embutidas.
 */
export const canonicalUrl = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;

  url.hash = '';
  url.protocol = 'https:';
  return url.href;
};

/** `www.exemplo.com` de `https://www.exemplo.com/a`; o texto inteiro se não for URL. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const WITH_SCHEME =/\bhttps?:\/\/[^\s<>"'`]+/gi;
// Domínio digitado sem esquema: `exemplo.com.br/artigo`. Não pega e-mail nem o meio de outra URL.
const WITHOUT_SCHEME = /(?<![@\w./:-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"'`]*)?/gi;
const TRAILING = /[.,;:!?)\]}]+$/;

/** URLs escritas num texto, já na forma comparável; sem esquema vira `https://`. */
export const urlsInText = (text: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(WITH_SCHEME)) {
    found.push(match[0].replace(TRAILING, ''));
  }
  for (const match of text.replace(WITH_SCHEME, ' ').matchAll(WITHOUT_SCHEME)) {
    found.push(`https://${match[0].replace(TRAILING, '')}`);
  }
  return found.flatMap((raw) => canonicalUrl(raw) ?? []);
};

/** As Fontes dos resultados de Ferramenta, já na forma comparável. */
export const sourceUrls = (parts: Part[]): string[] =>
  parts.flatMap((part) =>
    part.type === 'tool_result' ? part.sources.flatMap(({ url }) => canonicalUrl(url) ?? []) : [],
  );

/**
 * URLs que uma Leitura pode pedir: as Fontes de todo resultado de Ferramenta
 * gravado nesta Conversa, as URLs que a pessoa escreveu e as Fontes das
 * Rodadas anteriores da resposta em curso (`draft`). Texto do assistant, Anexo
 * e o conteúdo devolvido pelas Ferramentas não contam: o Modelo não constrói
 * destino novo nem acrescenta dado a uma URL que já estava aqui.
 */
export const eligibleUrls = (history: Message[], draft: Part[]): Set<string> => {
  const urls = new Set<string>();
  for (const message of history) {
    for (const url of sourceUrls(message.parts)) urls.add(url);
    if (message.role !== 'user') continue;
    for (const part of message.parts) {
      if (part.type === 'text') for (const url of urlsInText(part.text)) urls.add(url);
    }
  }
  for (const url of sourceUrls(draft)) urls.add(url);
  return urls;
};
