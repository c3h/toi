import type { Conversation } from '../../domain/conversation';
import type { AppErrorCode } from '../../domain/error';
import type { Message, MessageStatus, Part } from '../../domain/message';
import type { Model } from '../../domain/model';
import type { StopReason } from '../../domain/usage';

/**
 * Forma gravada no IndexedDB. A estrutura é escrita à mão, não derivada do
 * domínio: mudar o domínio quebra o mapeamento aqui, e a mudança de schema
 * vira uma `version()` com `upgrade()` em `db.ts`, não uma surpresa nos dados
 * de quem já usa. A forma da v1 é idêntica ao domínio da v1.
 */
export interface ConversationRecord {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export type PartRecord =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature: string };

export interface MessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  parts: PartRecord[];
  status: MessageStatus;
  createdAt: number;
  completedAt: number | null;
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
  stream: { owner: string; heartbeatAt: number } | null;
}

export const toConversationRecord = (conversation: Conversation): ConversationRecord => ({
  id: conversation.id,
  title: conversation.title,
  model: conversation.model,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
});

export const fromConversationRecord = (record: ConversationRecord): Conversation => ({
  id: record.id,
  title: record.title,
  model: record.model,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const toPartRecord = (part: Part): PartRecord => {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'reasoning':
      return { type: 'reasoning', text: part.text, signature: part.signature };
  }
};

const fromPartRecord = (record: PartRecord): Part => {
  switch (record.type) {
    case 'text':
      return { type: 'text', text: record.text };
    case 'reasoning':
      return { type: 'reasoning', text: record.text, signature: record.signature };
  }
};

export const toMessageRecord = (message: Message): MessageRecord => ({
  id: message.id,
  conversationId: message.conversationId,
  seq: message.seq,
  role: message.role,
  parts: message.parts.map(toPartRecord),
  status: message.status,
  createdAt: message.createdAt,
  completedAt: message.completedAt,
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
  stream: message.stream && { owner: message.stream.owner, heartbeatAt: message.stream.heartbeatAt },
});

export const fromMessageRecord = (record: MessageRecord): Message => ({
  id: record.id,
  conversationId: record.conversationId,
  seq: record.seq,
  role: record.role,
  parts: record.parts.map(fromPartRecord),
  status: record.status,
  createdAt: record.createdAt,
  completedAt: record.completedAt,
  model: record.model,
  usage: record.usage && { ...record.usage },
  stopReason: record.stopReason,
  error: record.error && { ...record.error },
  stream: record.stream && { ...record.stream },
});

/** Item do cache de Modelos em `settings`. */
export interface ModelRecord {
  id: string;
  displayName: string;
  maxTokens: number | null;
  maxInputTokens: number | null;
  createdAt: string;
}

export const toModelRecord = (model: Model): ModelRecord => ({
  id: model.id,
  displayName: model.displayName,
  maxTokens: model.maxTokens,
  maxInputTokens: model.maxInputTokens,
  createdAt: model.createdAt,
});

export const fromModelRecord = (record: ModelRecord): Model => ({
  id: record.id,
  displayName: record.displayName,
  maxTokens: record.maxTokens,
  maxInputTokens: record.maxInputTokens,
  createdAt: record.createdAt,
});
