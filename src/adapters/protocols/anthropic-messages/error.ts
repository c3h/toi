import {
  AppError,
  messageFor,
  type AppErrorCode,
  type AppErrorOptions,
} from '../../../domain/error';
import { isJsonObject } from '../../../domain/json';
import type { ProviderInfo } from '../../../ports/chat-provider';
import { parseRetryAfter, type HttpErrors } from '../../http/fetch';
import type { AnthropicErrorEnvelope } from './types';

const isEnvelope = (value: unknown): value is AnthropicErrorEnvelope =>
  isJsonObject(value) &&
  value.type === 'error' &&
  isJsonObject(value.error) &&
  typeof value.error.type === 'string' &&
  typeof value.error.message === 'string';

/** O `error.type` da API no código do domínio, para a resposta HTTP e para o evento do stream. */
const CODES: Record<string, AppErrorCode> = {
  authentication_error: 'invalid_credential',
  permission_error: 'permission_denied',
  not_found_error: 'model_unavailable',
  rate_limit_error: 'rate_limited',
  overloaded_error: 'overloaded',
  api_error: 'api_error',
  invalid_request_error: 'invalid_request',
};

/** Tipo que a API acrescentar e o Toi não conhece é `unknown` (§7). */
const codeForType = (apiType: string): AppErrorCode =>
  Object.hasOwn(CODES, apiType) ? CODES[apiType]! : 'unknown';

/** O status decide; o tipo do envelope, quando há envelope, só reforça 429 e 529. */
const codeForStatus = (status: number, typed: AppErrorCode | null, detail: string): AppErrorCode => {
  if (status === 401) return /cors/i.test(detail) ? 'browser_access_blocked' : 'invalid_credential';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'model_unavailable';
  if (status === 413) return 'request_too_large';
  if (status === 429 || typed === 'rate_limited') return 'rate_limited';
  if (status === 529 || typed === 'overloaded') return 'overloaded';

  if (status === 400) {
    if (/prompt is too long|context|too many tokens|input length/i.test(detail)) {
      return 'context_overflow';
    }
    // O status não separa o anexo recusado (páginas, imagem ilegível ou grande) dos outros 400.
    if (/\b(image|pdf|document)s?\b|\bpages?\b/i.test(detail)) return 'attachment_rejected';
    return 'invalid_request';
  }

  if (status >= 500) return 'api_error';
  return 'unknown';
};

export interface AnthropicMessagesErrors extends HttpErrors {
  fromEvent(event: { type: string; message: string }): AppError;
  unreadable(cause: unknown): AppError;
  noBody(): AppError;
}

/**
 * Erros do Protocolo Messages. A copy que nomeia o Provedor vem do descritor:
 * o mesmo Protocolo pode ser servido por mais de um Provedor.
 */
export const anthropicMessagesErrors = (provider: ProviderInfo): AnthropicMessagesErrors => {
  const messages: Partial<Record<AppErrorCode, string>> = {
    api_error: `Erro do lado ${provider.of}.`,
    unreachable: `Não foi possível falar com ${provider.the}.`,
  };

  const providerError = (code: AppErrorCode, options: AppErrorOptions = {}): AppError =>
    new AppError(code, messages[code] ?? messageFor(code), options);

  return {
    async fromResponse(response, now) {
      const body: unknown = await response.json().catch(() => null);

      // Sem envelope (proxy, corpo ilegível), o status decide sozinho e o `statusText` é o detalhe.
      const envelope = isEnvelope(body) ? body.error : null;
      const detail = envelope === null ? response.statusText : envelope.message;
      const code = codeForStatus(response.status, envelope && codeForType(envelope.type), detail);

      return providerError(code, {
        detail,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after'), now),
      });
    },

    fromEvent: (event) => providerError(codeForType(event.type), { detail: event.message }),

    unreachable: (cause) => providerError('unreachable', { cause }),

    unreadable: (cause) =>
      new AppError('unknown', `${capitalize(provider.the)} enviou uma resposta ilegível.`, { cause }),

    noBody: () => new AppError('unknown', `${capitalize(provider.the)} respondeu sem corpo.`),
  };
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
