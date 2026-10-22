import type { Part } from '../../../domain/message';
import type { Effort } from '../../../domain/model';
import type { ChatRequest } from '../../../ports/chat-provider';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string };

export interface AnthropicPayload {
  model: string;
  max_tokens: number;
  stream: true;
  system?: string;
  output_config: { effort: Effort };
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
  output_config: { effort: request.effort },
  messages: request.messages.map((message) => ({
    role: message.role,
    content: message.parts.map(toContentBlock),
  })),
});

/** Headers do Protocolo; autenticação e acesso pelo navegador são do Provedor. */
export const ANTHROPIC_MESSAGES_HEADERS = { 'anthropic-version': '2026-10-21' } as const;
