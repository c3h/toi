import type { Attachment, ImageMediaType } from '../../domain/attachment';
import type { Conversation } from '../../domain/conversation';
import type { AppErrorCode, AppErrorInfo } from '../../domain/error';
import type { ProviderId } from '../../domain/ids';
import type { JsonObject } from '../../domain/json';
import type { Message, MessageStatus, Part } from '../../domain/message';
import type { Effort, FamilyRef, Model, ModelPicks, ModelRef } from '../../domain/model';
import type { StopReason } from '../../domain/usage';
import type { FetchFailureCode } from '../../domain/web';

/**
 * Forma gravada no IndexedDB. A estrutura é escrita à mão, não derivada do
 * domínio: mudar o domínio quebra o mapeamento aqui em vez de mudar o dado em
 * silêncio. `ProviderId` e `Effort`, como as outras enumerações, vêm do domínio.
 */
export interface ConversationRecord {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  effort: Effort;
  createdAt: number;
  updatedAt: number;
}

export type AttachmentRecord =
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

export interface ErrorRecord {
  code: AppErrorCode;
  message: string;
  detail: string | null;
  retryAfterSeconds: number | null;
}

export type PartRecord =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature: string }
  | { type: 'redacted_reasoning'; data: string }
  | { type: 'file'; attachment: AttachmentRecord }
  /** `input` é o JSON que o Modelo mandou, gravado como veio. */
  | { type: 'tool_call'; callId: string; tool: string; input: JsonObject }
  | {
      type: 'tool_result';
      callId: string;
      content: string;
      sources: Array<{ title: string; url: string }>;
      failures: Array<{ url: string; code: FetchFailureCode }>;
      error: ErrorRecord | null;
    };

/** Os bytes de um Anexo, fora da Mensagem; `conversationId` serve à cascata. */
export interface AttachmentBytesRecord {
  id: string;
  conversationId: string;
  blob: Blob;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  parts: PartRecord[];
  status: MessageStatus;
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
  error: ErrorRecord | null;
}

export const toConversationRecord = (conversation: Conversation): ConversationRecord => ({
  id: conversation.id,
  title: conversation.title,
  provider: conversation.provider,
  model: conversation.model,
  effort: conversation.effort,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
});

export const fromConversationRecord = (record: ConversationRecord): Conversation => ({
  id: record.id,
  title: record.title,
  provider: record.provider,
  model: record.model,
  effort: record.effort,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const toAttachmentRecord = (attachment: Attachment): AttachmentRecord => {
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

const fromAttachmentRecord = (record: AttachmentRecord): Attachment => {
  const { id, name, size } = record;
  switch (record.kind) {
    case 'image':
      return {
        id,
        kind: 'image',
        name,
        size,
        mediaType: record.mediaType,
        width: record.width,
        height: record.height,
      };
    case 'pdf':
      return { id, kind: 'pdf', name, size, pages: record.pages };
    case 'text':
      return { id, kind: 'text', name, size };
  }
};

const toErrorRecord = (error: AppErrorInfo): ErrorRecord => ({
  code: error.code,
  message: error.message,
  detail: error.detail,
  retryAfterSeconds: error.retryAfterSeconds,
});

const fromErrorRecord = (record: ErrorRecord): AppErrorInfo => ({ ...record });

/** Cópia do JSON: o registro não compartilha objeto com o domínio. */
const copyJson = (value: JsonObject): JsonObject => structuredClone(value);

const toPartRecord = (part: Part): PartRecord => {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'reasoning':
      return { type: 'reasoning', text: part.text, signature: part.signature };
    case 'redacted_reasoning':
      return { type: 'redacted_reasoning', data: part.data };
    case 'file':
      return { type: 'file', attachment: toAttachmentRecord(part.attachment) };
    case 'tool_call':
      return { type: 'tool_call', callId: part.callId, tool: part.tool, input: copyJson(part.input) };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: part.callId,
        content: part.content,
        sources: part.sources.map(({ title, url }) => ({ title, url })),
        failures: part.failures.map(({ url, code }) => ({ url, code })),
        error: part.error && toErrorRecord(part.error),
      };
  }
};

const fromPartRecord = (record: PartRecord): Part => {
  switch (record.type) {
    case 'text':
      return { type: 'text', text: record.text };
    case 'reasoning':
      return { type: 'reasoning', text: record.text, signature: record.signature };
    case 'redacted_reasoning':
      return { type: 'redacted_reasoning', data: record.data };
    case 'file':
      return { type: 'file', attachment: fromAttachmentRecord(record.attachment) };
    case 'tool_call':
      return {
        type: 'tool_call',
        callId: record.callId,
        tool: record.tool,
        input: copyJson(record.input),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: record.callId,
        content: record.content,
        sources: record.sources.map(({ title, url }) => ({ title, url })),
        failures: record.failures.map(({ url, code }) => ({ url, code })),
        error: record.error && fromErrorRecord(record.error),
      };
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
  error: message.error && toErrorRecord(message.error),
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
  firstTokenAt: record.firstTokenAt,
  provider: record.provider,
  model: record.model,
  effort: record.effort,
  usage: record.usage && { ...record.usage },
  stopReason: record.stopReason,
  error: record.error && fromErrorRecord(record.error),
});

/** Item do cache de Modelos em `settings`, um cache por Provedor. */
export interface ModelRecord {
  provider: ProviderId;
  id: string;
  displayName: string;
  family: string;
  maxTokens: number | null;
  maxInputTokens: number | null;
  createdAt: string;
}

export const toModelRecord = (model: Model): ModelRecord => ({
  provider: model.provider,
  id: model.id,
  displayName: model.displayName,
  family: model.family,
  maxTokens: model.maxTokens,
  maxInputTokens: model.maxInputTokens,
  createdAt: model.createdAt,
});

export const fromModelRecord = (record: ModelRecord): Model => ({
  provider: record.provider,
  id: record.id,
  displayName: record.displayName,
  family: record.family,
  maxTokens: record.maxTokens,
  maxInputTokens: record.maxInputTokens,
  createdAt: record.createdAt,
});

export interface ModelRefRecord {
  provider: ProviderId;
  id: string;
}

export interface FamilyRefRecord {
  provider: ProviderId;
  name: string;
}

export const toModelRefRecord = (ref: ModelRef): ModelRefRecord => ({
  provider: ref.provider,
  id: ref.id,
});

export const fromModelRefRecord = (record: ModelRefRecord): ModelRef => ({
  provider: record.provider,
  id: record.id,
});

const toFamilyRefRecord = (ref: FamilyRef): FamilyRefRecord => ({
  provider: ref.provider,
  name: ref.name,
});

const fromFamilyRefRecord = (record: FamilyRefRecord): FamilyRef => ({
  provider: record.provider,
  name: record.name,
});

export interface ModelPicksRecord {
  families: FamilyRefRecord[];
  models: ModelRefRecord[];
}

export const toModelPicksRecord = (picks: ModelPicks): ModelPicksRecord => ({
  families: picks.families.map(toFamilyRefRecord),
  models: picks.models.map(toModelRefRecord),
});

export const fromModelPicksRecord = (record: ModelPicksRecord): ModelPicks => ({
  families: record.families.map(fromFamilyRefRecord),
  models: record.models.map(fromModelRefRecord),
});
