export type ConversationId = string;
export type MessageId = string;
export type AttachmentId = string;
/** Fechada de propósito: acrescentar um Provedor é compatível com o que já está gravado. */
export type ProviderId = 'anthropic';
/** Quem executa as Ferramentas, com Chave própria. */
export type ServiceId = 'tinyfish';
/** Dono de uma Chave: um Provedor ou um Serviço. */
export type CredentialOwner = ProviderId | ServiceId;

export const newId = (): string => crypto.randomUUID();
