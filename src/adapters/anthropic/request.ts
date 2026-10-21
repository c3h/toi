import type { Part } from '../../domain/message';
import type { ChatRequest } from '../../ports/chat-provider';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string };

export interface AnthropicPayload {
  model: string;
  max_tokens: number;
  stream: true;
  system?: string;
  temperature?: number;
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }>;
}

const toContentBlock = (part: Part): AnthropicContentBlock => {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'reasoning':
      return { type: 'thinking', thinking: part.text, signature: part.signature };
  }
};

export const toAnthropicPayload = (request: ChatRequest): AnthropicPayload => ({
  model: request.model,
  max_tokens: request.maxTokens,
  stream: true,
  ...(request.system === undefined ? {} : { system: request.system }),
  ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  messages: request.messages.map((message) => ({
    role: message.role,
    content: message.parts.map(toContentBlock),
  })),
});
