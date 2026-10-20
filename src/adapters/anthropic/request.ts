import type { ChatRequest } from '../../ports/chat-provider';

export interface AnthropicPayload {
  model: string;
  max_tokens: number;
  stream: true;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export const toAnthropicPayload = (request: ChatRequest): AnthropicPayload => ({
  model: request.model,
  max_tokens: request.maxTokens,
  stream: true,
  messages: request.messages.map((message) => ({
    role: message.role,
    content: message.content,
  })),
});
