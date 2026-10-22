import type { Clock } from '../../../ports/clock';
import { fetchOrThrow, type FetchLike } from '../../http/fetch';
import { ANTHROPIC_MESSAGES_HEADERS } from '../../protocols/anthropic-messages/request';
import { anthropicErrors } from './info';

export const API_URL = 'https://api.anthropic.com/v1';

/**
 * Autenticação da Anthropic. O header de acesso pelo navegador fica aqui, não
 * no Protocolo: só vai para `api.anthropic.com` (ADR 0002).
 */
export const anthropicFetch = (
  fetchImpl: FetchLike,
  apiKey: string,
  url: URL | string,
  init: RequestInit & { headers?: Record<string, string> },
  clock: Clock,
): Promise<Response> =>
  fetchOrThrow(
    fetchImpl,
    url,
    {
      ...init,
      headers: {
        ...init.headers,
        ...ANTHROPIC_MESSAGES_HEADERS,
        'x-api-key': apiKey,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    },
    anthropicErrors,
    clock,
  );
