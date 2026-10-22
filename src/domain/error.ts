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
  | 'tool_invalid_credential'
  | 'tool_quota_exhausted'
  | 'tool_rate_limited'
  | 'tool_invalid_input'
  | 'tool_forbidden'
  | 'tool_url_not_eligible'
  | 'tool_call_limit'
  | 'tool_unreachable'
  | 'tool_bad_response'
  | 'tool_limit'
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
  tool_invalid_credential: 'A Chave da busca na web foi recusada.',
  tool_quota_exhausted: 'A cota diária da busca na web acabou.',
  tool_rate_limited: 'Limite de buscas por minuto atingido.',
  tool_invalid_input: 'O serviço de busca recusou o pedido do Modelo.',
  tool_forbidden: 'O serviço de busca não permitiu o pedido.',
  tool_url_not_eligible: 'O Modelo pediu um endereço que não está na conversa.',
  tool_call_limit: 'O Modelo passou do limite de buscas desta resposta.',
  tool_unreachable: 'Não foi possível falar com o serviço de busca.',
  tool_bad_response: 'O serviço de busca enviou uma resposta ilegível.',
  tool_limit: 'A resposta passou do limite de buscas e leituras.',
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

/** O Modelo encerrou a Rodada com um pedido de Ferramenta que não fecha em JSON. */
export const brokenToolCallError = (): AppError =>
  new AppError('unknown', 'A resposta trouxe um pedido de ferramenta ilegível.');

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
