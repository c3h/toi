import type { Attachment, ImageMediaType } from '../../domain/attachment';
import type { Conversation } from '../../domain/conversation';
import type { AppErrorCode } from '../../domain/error';
import type { ProviderId } from '../../domain/ids';
import type { Message, MessageStatus, Part } from '../../domain/message';
import type { Effort, FamilyRef, Model, ModelPicks, ModelRef } from '../../domain/model';
import type { StopReason } from '../../domain/usage';

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

export type PartRecord =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature: string }
  | { type: 'file'; attachment: AttachmentRecord };

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
  error: {
    code: AppErrorCode;
    message: string;
    detail: string | null;
    retryAfterSeconds: number | null;
  } | null;
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

const toPartRecord = (part: Part): PartRecord => {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'reasoning':
      return { type: 'reasoning', text: part.text, signature: part.signature };
    case 'file':
      return { type: 'file', attachment: toAttachmentRecord(part.attachment) };
  }
};

const fromPartRecord = (record: PartRecord): Part => {
  switch (record.type) {
    case 'text':
      return { type: 'text', text: record.text };
    case 'reasoning':
      return { type: 'reasoning', text: record.text, signature: record.signature };
    case 'file':
      return { type: 'file', attachment: fromAttachmentRecord(record.attachment) };
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
  error: message.error && {
    code: message.error.code,
    message: message.error.message,
    detail: message.error.detail,
    retryAfterSeconds: message.error.retryAfterSeconds,
  },
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
  error: record.error && { ...record.error },
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
