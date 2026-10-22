import type { Conversation } from '../domain/conversation';
import type { AppErrorCode } from '../domain/error';
import type { ProviderId } from '../domain/ids';
import type { Message, Part } from '../domain/message';
import type { StopReason } from '../domain/usage';
import type { Clock } from '../ports/clock';
import type { ConversationStore } from '../ports/conversation-store';

/**
 * Formato do arquivo de exportação. É contrato com arquivos que já saíram do
 * app: a estrutura é escrita à mão, não derivada do domínio, para que mudar
 * o domínio quebre o mapeamento aqui em vez de mudar o arquivo em silêncio.
 * Enumerações (`StopReason`, `AppErrorCode`) vêm do domínio: acrescentar um
 * valor é compatível. Mudança incompatível sobe `version`.
 *
 * `provider` entrou depois da primeira versão, como campo novo: num arquivo
 * sem ele, a Conversa e as respostas são da Anthropic.
 */
export const HISTORY_EXPORT_FORMAT = 'toi.history';
export const HISTORY_EXPORT_VERSION = 1;

export type ExportedPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature: string };

export interface ExportedMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  parts: ExportedPart[];
  status: 'complete' | 'interrupted' | 'failed';
  createdAt: number;
  completedAt: number | null;
  provider: ProviderId | null;
  model: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  } | null;
  stopReason: StopReason | null;
  error: {
    code: AppErrorCode;
    message: string;
    detail: string | null;
    retryAfterSeconds: number | null;
  } | null;
}

export interface ExportedConversation {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: ExportedMessage[];
}

export interface HistoryExport {
  format: typeof HISTORY_EXPORT_FORMAT;
  version: typeof HISTORY_EXPORT_VERSION;
  exportedAt: number;
  conversations: ExportedConversation[];
}

export interface ExportDeps {
  store: ConversationStore;
  clock: Clock;
}

const exportPart = (part: Part): ExportedPart => {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'reasoning':
      return { type: 'reasoning', text: part.text, signature: part.signature };
  }
};

const exportMessage = (message: Message): ExportedMessage => ({
  id: message.id,
  seq: message.seq,
  role: message.role,
  parts: message.parts.map(exportPart),
  // O arquivo é um retrato: um Fluxo em voo sai como o que é fora do app, interrompido.
  status: message.status === 'streaming' ? 'interrupted' : message.status,
  createdAt: message.createdAt,
  completedAt: message.completedAt,
  provider: message.provider,
  model: message.model,
  usage: message.usage && {
    inputTokens: message.usage.inputTokens,
    outputTokens: message.usage.outputTokens,
    cacheCreationInputTokens: message.usage.cacheCreationInputTokens,
    cacheReadInputTokens: message.usage.cacheReadInputTokens,
  },
  stopReason: message.stopReason,
  error: message.error && {
    code: message.error.code,
    message: message.error.message,
    detail: message.error.detail,
    retryAfterSeconds: message.error.retryAfterSeconds,
  },
});

const exportConversation = (
  conversation: Conversation,
  messages: Message[],
): ExportedConversation => ({
  id: conversation.id,
  title: conversation.title,
  provider: conversation.provider,
  model: conversation.model,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  messages: messages.map(exportMessage),
});

/** Lê só a porta de Conversas: a Chave não tem caminho até o arquivo. */
export const exportHistory = async (deps: ExportDeps): Promise<HistoryExport> => {
  const conversations = await deps.store.listConversations();

  return {
    format: HISTORY_EXPORT_FORMAT,
    version: HISTORY_EXPORT_VERSION,
    exportedAt: deps.clock.now(),
    conversations: await Promise.all(
      conversations.map(async (conversation) =>
        exportConversation(conversation, await deps.store.listMessages(conversation.id)),
      ),
    ),
  };
};
