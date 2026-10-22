import type { ImageMediaType } from '../../../domain/attachment';
import type { Effort } from '../../../domain/model';
import type { ChatRequest, OutgoingPart } from '../../../ports/chat-provider';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  | {
      type: 'document';
      title: string;
      source:
        | { type: 'base64'; media_type: 'application/pdf'; data: string }
        | { type: 'text'; media_type: 'text/plain'; data: string };
    };

export interface AnthropicPayload {
  model: string;
  max_tokens: number;
  stream: true;
  system?: string;
  output_config: { effort: Effort };
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }>;
}

const base64 = async (blob: Blob): Promise<string> => (await blob.bytes()).toBase64();

/** Arquivo de texto vai como documento: fica separado da fala da pessoa, com o nome como título. */
const fileBlock = async ({
  attachment,
  data,
}: Extract<OutgoingPart, { type: 'file' }>): Promise<AnthropicContentBlock> => {
  switch (attachment.kind) {
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: attachment.mediaType, data: await base64(data) },
      };
    case 'pdf':
      return {
        type: 'document',
        title: attachment.name,
        source: { type: 'base64', media_type: 'application/pdf', data: await base64(data) },
      };
    case 'text':
      return {
        type: 'document',
        title: attachment.name,
        source: { type: 'text', media_type: 'text/plain', data: await data.text() },
      };
  }
};

const toContentBlock = async (part: OutgoingPart): Promise<AnthropicContentBlock> => {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'reasoning':
      return { type: 'thinking', thinking: part.text, signature: part.signature };
    case 'file':
      return fileBlock(part);
  }
};

/** Lê os bytes dos Anexos aqui, para viverem só até o corpo da requisição sair. */
export const toAnthropicPayload = async (request: ChatRequest): Promise<AnthropicPayload> => ({
  model: request.model,
  max_tokens: request.maxTokens,
  stream: true,
  ...(request.system === undefined ? {} : { system: request.system }),
  output_config: { effort: request.effort },
  messages: await Promise.all(
    request.messages.map(async (message) => ({
      role: message.role,
      content: await Promise.all(message.parts.map(toContentBlock)),
    })),
  ),
});

/** Headers do Protocolo; autenticação e acesso pelo navegador são do Provedor. */
export const ANTHROPIC_MESSAGES_HEADERS = { 'anthropic-version': '2026-10-21' } as const;
