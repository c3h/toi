export type AppErrorCode =
  | 'invalid_credential'
  | 'browser_access_blocked'
  | 'permission_denied'
  | 'model_unavailable'
  | 'context_overflow'
  | 'request_too_large'
  | 'attachment_rejected'
  | 'invalid_request'
  | 'rate_limited'
  | 'overloaded'
  | 'api_error'
  | 'unreachable'
  | 'aborted'
  | 'not_connected'
  | 'flow_busy'
  | 'storage_failed'
  | 'storage_full'
  | 'unknown';

export interface AppErrorOptions {
  detail?: string;
  retryAfterSeconds?: number | null;
  cause?: unknown;
}

const MESSAGES: Record<AppErrorCode, string> = {
  invalid_credential: 'Chave inválida ou revogada.',
  browser_access_blocked: 'Sua organização bloqueia chamadas do navegador.',
  permission_denied: 'Esta Chave não tem acesso ao Modelo.',
  model_unavailable: 'Modelo indisponível.',
  context_overflow: 'A conversa passou do limite do Modelo.',
  request_too_large: 'O pedido é grande demais.',
  attachment_rejected: 'O Modelo recusou um dos anexos.',
  invalid_request: 'O pedido foi recusado.',
  rate_limited: 'Limite de requisições atingido.',
  overloaded: 'O Modelo está sobrecarregado.',
  api_error: 'Erro do lado do serviço.',
  unreachable: 'Sem conexão com o serviço.',
  aborted: 'Requisição cancelada.',
  not_connected: 'Conecte uma Chave para conversar.',
  flow_busy: 'Espere a operação atual terminar, nesta ou em outra aba.',
  storage_failed: 'Não foi possível salvar tudo no navegador.',
  storage_full: 'O navegador ficou sem espaço para salvar esta Mensagem.',
  unknown: 'Algo deu errado.',
};

export const messageFor = (code: AppErrorCode): string => MESSAGES[code];

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

export const appError = (code: AppErrorCode, options: AppErrorOptions = {}): AppError =>
  new AppError(code, messageFor(code), options);

export const asAppError = (error: unknown): AppError =>
  error instanceof AppError ? error : appError('unknown', { cause: error });

/** O Fluxo fechou sem `finished`: a conexão caiu no meio da resposta. */
export const truncatedError = (): AppError =>
  new AppError('unreachable', 'A resposta terminou antes do fim.');

/** Os bytes de um Anexo sumiram do navegador; a requisição não sai sem eles. */
export const missingAttachmentError = (): AppError =>
  new AppError('storage_failed', 'Um anexo desta conversa não está mais no navegador.');

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
