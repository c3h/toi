import type { ServiceId } from '../domain/ids';
import type { FetchFailure } from '../domain/web';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Data de publicação como o Serviço a dá; `null` quando ele não sabe. */
  date: string | null;
}

export interface SearchOutcome {
  hits: SearchHit[];
}

export interface FetchedPage {
  /** Depois dos redirects. */
  finalUrl: string;
  title: string | null;
  text: string;
}

export interface FetchOutcome {
  pages: FetchedPage[];
  failures: FetchFailure[];
}

/**
 * Contrato do Serviço que executa as Ferramentas. `search` e `fetch` recusam
 * com `AppError` tipado (`tool_*`) a falha da chamada inteira; a falha de uma
 * URL de um lote vem em `failures`. `verify` valida a Chave sem gastar cota.
 * O adaptador não monta o texto que vai ao Modelo, não grava e não decide UI.
 */
export interface WebTools {
  search(query: { text: string; language: string }, signal: AbortSignal): Promise<SearchOutcome>;
  fetch(urls: string[], signal: AbortSignal): Promise<FetchOutcome>;
  verify(signal: AbortSignal): Promise<void>;
}

/** O que a UI pode saber de um Serviço, como `ProviderInfo` para o Provedor. */
export interface ServiceInfo {
  id: ServiceId;
  name: string;
  /** "da TinyFish". */
  of: string;
  /** "à TinyFish". */
  to: string;
  keyPlaceholder: string;
  keysUrl: string;
  termsUrl: string;
}

export interface ServiceAdapter {
  info: ServiceInfo;
  create(apiKey: string): WebTools;
}
