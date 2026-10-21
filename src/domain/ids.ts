export type ConversationId = string;
export type MessageId = string;
export type ProviderId = 'anthropic';

export const ANTHROPIC_PROVIDER: ProviderId = 'anthropic';

export const newId = (): string => crypto.randomUUID();
