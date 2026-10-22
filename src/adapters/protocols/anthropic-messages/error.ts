import {
  AppError,
  messageFor,
  type AppErrorCode,
  type AppErrorOptions,
} from '../../../domain/error';
import type { ProviderInfo } from '../../../ports/chat-provider';
import { parseRetryAfter, type HttpErrors } from '../../http/fetch';
import type { AnthropicErrorEnvelope } from './types';

const isEnvelope = (value: unknown): value is AnthropicErrorEnvelope => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; error?: unknown };
  if (candidate.type !== 'error' || typeof candidate.error !== 'object' || candidate.error === null) {
    return false;
  }
  const error = candidate.error as { type?: unknown; message?: unknown };
  return typeof error.type === 'string' && typeof error.message === 'string';
};

const codeForStatus = (status: number, apiType: string, detail: string): AppErrorCode => {
  if (status === 401) return /cors/i.test(detail) ? 'browser_access_blocked' : 'invalid_credential';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'model_unavailable';
  if (status === 413) return 'request_too_large';
  if (status === 429 || apiType === 'rate_limit_error') return 'rate_limited';
  if (status === 529 || apiType === 'overloaded_error') return 'overloaded';

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

const codeForEvent = (apiType: string): AppErrorCode => {
  switch (apiType) {
    case 'authentication_error':
      return 'invalid_credential';
    case 'permission_error':
      return 'permission_denied';
    case 'not_found_error':
      return 'model_unavailable';
    case 'rate_limit_error':
      return 'rate_limited';
    case 'overloaded_error':
      return 'overloaded';
    case 'api_error':
      return 'api_error';
    case 'invalid_request_error':
      return 'invalid_request';
    default:
      return 'unknown';
  }
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

      const envelope = isEnvelope(body) ? body : null;
      const apiType = envelope?.error.type ?? '';
      const detail = envelope?.error.message ?? response.statusText;
      const code = codeForStatus(response.status, apiType, detail);

      return providerError(code, {
        detail,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after'), now),
      });
    },

    fromEvent: (event) => providerError(codeForEvent(event.type), { detail: event.message }),

    unreachable: (cause) => providerError('unreachable', { cause }),

    unreadable: (cause) =>
      new AppError('unknown', `${capitalize(provider.the)} enviou uma resposta ilegível.`, { cause }),

    noBody: () => new AppError('unknown', `${capitalize(provider.the)} respondeu sem corpo.`),
  };
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
