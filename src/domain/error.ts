export type AppErrorCode =
  | 'invalid_credential'
  | 'browser_access_blocked'
  | 'permission_denied'
  | 'model_unavailable'
  | 'context_overflow'
  | 'request_too_large'
  | 'invalid_request'
  | 'rate_limited'
  | 'overloaded'
  | 'api_error'
  | 'unreachable'
  | 'aborted'
  | 'unknown';

interface AppErrorOptions {
  detail?: string;
  retryAfterSeconds?: number | null;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly detail: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.detail = options.detail ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface AppErrorInfo {
  code: AppErrorCode;
  message: string;
  detail: string | null;
  retryAfterSeconds: number | null;
}

export const toErrorInfo = (error: AppError): AppErrorInfo => ({
  code: error.code,
  message: error.message,
  detail: error.detail,
  retryAfterSeconds: error.retryAfterSeconds,
});

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';
