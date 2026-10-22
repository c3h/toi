import type { Attachment, ImageMediaType } from '../domain/attachment';
import { missingAttachmentError, type AppErrorCode, type AppErrorInfo } from '../domain/error';
import type { AttachmentId, ProviderId } from '../domain/ids';
import type { JsonObject } from '../domain/json';
import type { Message, Part } from '../domain/message';
import type { Effort } from '../domain/model';
import type { StopReason } from '../domain/usage';
import type { FetchFailureCode } from '../domain/web';
import type { Clock } from '../ports/clock';
import type { ConversationStore } from '../ports/conversation-store';

/**
 * Formato do arquivo de exportação. É contrato com arquivos que já saíram do
 * app: a estrutura é escrita à mão, não derivada do domínio, para que mudar
 * o domínio quebre o mapeamento aqui em vez de mudar o arquivo em silêncio.
 * Enumerações (`StopReason`, `AppErrorCode`, `Effort`, `FetchFailureCode`) vêm do
 * domínio: acrescentar um valor é compatível, como as Partes `file`, `tool_call`,
 * `tool_result` e `redacted_reasoning`. Mudança incompatível sobe `version`.
 */
export const HISTORY_EXPORT_FORMAT = 'toi.history';
export const HISTORY_EXPORT_VERSION = 1;

export type ExportedAttachment =
  | {
      id: string;
      kind: 'image';
      name: string;
      size: number;
      mediaType: ImageMediaType;
      width: number;
      height: number;
    }
  | { id: string; kind: 'pdf'; name: string; size: number; pages: number | null }
  | { id: string; kind: 'text'; name: string; size: number };

export interface ExportedError {
  code: AppErrorCode;
  message: string;
  detail: string | null;
  retryAfterSeconds: number | null;
}

export type ExportedPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature: string }
  | { type: 'redacted_reasoning'; data: string }
  /** `data` são os bytes do Anexo em base64, também para texto: o arquivo volta igual. */
  | { type: 'file'; attachment: ExportedAttachment; data: string }
  | { type: 'tool_call'; callId: string; tool: string; input: JsonObject }
  | {
      type: 'tool_result';
      callId: string;
      content: string;
      sources: Array<{ title: string; url: string }>;
      failures: Array<{ url: string; code: FetchFailureCode }>;
      error: ExportedError | null;
    };

export interface ExportedMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  parts: ExportedPart[];
  status: 'complete' | 'interrupted' | 'failed';
  createdAt: number;
  completedAt: number | null;
  firstTokenAt: number | null;
  provider: ProviderId | null;
  model: string | null;
  effort: Effort | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  } | null;
  stopReason: StopReason | null;
  error: ExportedError | null;
}

export interface ExportedConversation {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  effort: Effort;
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

const exportAttachment = (attachment: Attachment): ExportedAttachment => {
  const { id, name, size } = attachment;
  switch (attachment.kind) {
    case 'image':
      return {
        id,
        kind: 'image',
        name,
        size,
        mediaType: attachment.mediaType,
        width: attachment.width,
        height: attachment.height,
      };
    case 'pdf':
      return { id, kind: 'pdf', name, size, pages: attachment.pages };
    case 'text':
      return { id, kind: 'text', name, size };
  }
};

type Bytes = Map<AttachmentId, Blob>;

const exportError = (error: AppErrorInfo): ExportedError => ({
  code: error.code,
  message: error.message,
  detail: error.detail,
  retryAfterSeconds: error.retryAfterSeconds,
});

const exportPart = async (part: Part, bytes: Bytes): Promise<ExportedPart> => {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'reasoning':
      return { type: 'reasoning', text: part.text, signature: part.signature };
    case 'redacted_reasoning':
      return { type: 'redacted_reasoning', data: part.data };
    case 'file': {
      const blob = bytes.get(part.attachment.id);
      if (!blob) throw missingAttachmentError();
      const data = (await blob.bytes()).toBase64();
      return { type: 'file', attachment: exportAttachment(part.attachment), data };
    }
    case 'tool_call':
      return {
        type: 'tool_call',
        callId: part.callId,
        tool: part.tool,
        input: structuredClone(part.input),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: part.callId,
        content: part.content,
        sources: part.sources.map(({ title, url }) => ({ title, url })),
        failures: part.failures.map(({ url, code }) => ({ url, code })),
        error: part.error && exportError(part.error),
      };
  }
};

const exportMessage = async (message: Message, bytes: Bytes): Promise<ExportedMessage> => ({
  id: message.id,
  seq: message.seq,
  role: message.role,
  parts: await Promise.all(message.parts.map((part) => exportPart(part, bytes))),
  // O arquivo é um retrato: um Fluxo em voo sai como o que é fora do app, interrompido.
  status: message.status === 'streaming' ? 'interrupted' : message.status,
  createdAt: message.createdAt,
  completedAt: message.completedAt,
  firstTokenAt: message.firstTokenAt,
  provider: message.provider,
  model: message.model,
  effort: message.effort,
  usage: message.usage && {
    inputTokens: message.usage.inputTokens,
    outputTokens: message.usage.outputTokens,
    cacheCreationInputTokens: message.usage.cacheCreationInputTokens,
    cacheReadInputTokens: message.usage.cacheReadInputTokens,
  },
  stopReason: message.stopReason,
  error: message.error && exportError(message.error),
});

/** O JSON de `value` aberto num último campo `key`, um array cujos itens vêm depois. */
const openArray = (value: object, key: string): string =>
  `${JSON.stringify(value).slice(0, -1)},${JSON.stringify(key)}:[`;

/**
 * Lê um retrato transacional da porta de Conversas: a Chave não tem caminho
 * até o arquivo, e outra aba apagando no meio não deixa o arquivo pela metade.
 * O JSON sai em pedaços, uma Mensagem por vez, para os Anexos de todo o
 * histórico nunca virarem uma string só.
 */
export const exportHistory = async (deps: ExportDeps): Promise<Blob> => {
  const snapshot = await deps.store.snapshot();
  const header: Omit<HistoryExport, 'conversations'> = {
    format: HISTORY_EXPORT_FORMAT,
    version: HISTORY_EXPORT_VERSION,
    exportedAt: deps.clock.now(),
  };
  const chunks: BlobPart[] = [openArray(header, 'conversations')];

  for (const [index, { conversation, messages }] of snapshot.conversations.entries()) {
    const head: Omit<ExportedConversation, 'messages'> = {
      id: conversation.id,
      title: conversation.title,
      provider: conversation.provider,
      model: conversation.model,
      effort: conversation.effort,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
    if (index > 0) chunks.push(',');
    chunks.push(openArray(head, 'messages'));

    for (const [position, message] of messages.entries()) {
      const json = JSON.stringify(await exportMessage(message, snapshot.attachments));
      if (position > 0) chunks.push(',');
      // Como Blob, o texto pode sair da memória do JS antes da próxima Mensagem.
      chunks.push(new Blob([json]));
    }
    chunks.push(']}');
  }
  chunks.push(']}');

  return new Blob(chunks, { type: 'application/json' });
};
