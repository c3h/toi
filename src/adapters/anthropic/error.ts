import {
  AppError,
  messageFor,
  type AppErrorCode,
  type AppErrorOptions,
} from '../../domain/error';
import type { AnthropicErrorEnvelope } from './types';

// Copy que nomeia o Provedor fica no adaptador; o domínio só tem a genérica.
const ANTHROPIC_MESSAGES: Partial<Record<AppErrorCode, string>> = {
  api_error: 'Erro do lado da Anthropic.',
  unreachable: 'Não foi possível falar com a Anthropic.',
};

const anthropicError = (code: AppErrorCode, options: AppErrorOptions = {}): AppError =>
  new AppError(code, ANTHROPIC_MESSAGES[code] ?? messageFor(code), options);

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

const parseRetryAfter = (header: string | null, now: number): number | null => {
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;

  return Math.max(0, Math.ceil((date - now) / 1000));
};

export const errorFromResponse = async (response: Response, now: number): Promise<AppError> => {
  const body: unknown = await response.json().catch(() => null);

  const envelope = isEnvelope(body) ? body : null;
  const apiType = envelope?.error.type ?? '';
  const detail = envelope?.error.message ?? response.statusText;
  const code = codeForStatus(response.status, apiType, detail);

  return anthropicError(code, {
    detail,
    retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after'), now),
  });
};

export const errorFromEvent = (event: { type: string; message: string }): AppError => {
  const code = codeForEvent(event.type);
  return anthropicError(code, { detail: event.message });
};

export const unreachableError = (cause: unknown): AppError =>
  anthropicError('unreachable', { cause });

export const unreadableError = (cause: unknown): AppError =>
  new AppError('unknown', 'A Anthropic enviou uma resposta ilegível.', { cause });
