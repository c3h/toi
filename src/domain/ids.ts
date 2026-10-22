export type ConversationId = string;
export type MessageId = string;
export type AttachmentId = string;
/** Fechada de propósito: acrescentar um Provedor é compatível com o que já está gravado. */
export type ProviderId = 'anthropic';

export const newId = (): string => crypto.randomUUID();
