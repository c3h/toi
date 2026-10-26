import type { ImageMediaType } from '../../../domain/attachment';
import type { JsonObject } from '../../../domain/json';
import type { Effort } from '../../../domain/model';
import type { ChatRequest, OutgoingPart, ToolDefinition } from '../../../ports/chat-provider';

/** Como a API recebe o pedido de responder sem raciocinar; quem aceita qual é do Provedor. */
export type ThinkingOff = { type: 'disabled' } | { type: 'between_tools' };

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
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
  /** Cache automático: a API põe o breakpoint no último bloco e o move conforme a Conversa cresce. */
  cache_control: { type: 'ephemeral' };
  system?: string;
  thinking?: ThinkingOff;
  output_config: { effort: Effort };
  tools?: AnthropicTool[];
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }>;
}

/**
 * Sem `eager_input_streaming`: os inputs são curtos, e a API só emite o JSON
 * de cada parâmetro depois de validá-lo, o que vale mais que vê-lo chegar.
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonObject;
}

const toTool = (tool: ToolDefinition): AnthropicTool => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
});

// Cada Rodada reenvia os mesmos Blobs do turno: codifica uma vez por Blob, que leva o cache junto.
const encoded = new WeakMap<Blob, Promise<string>>();

const base64 = (blob: Blob): Promise<string> => {
  let data = encoded.get(blob);
  if (data === undefined) {
    data = blob.bytes().then((bytes) => bytes.toBase64());
    encoded.set(blob, data);
  }
  return data;
};

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
    case 'redacted_reasoning':
      return { type: 'redacted_thinking', data: part.data };
    case 'file':
      return fileBlock(part);
    case 'tool_call':
      return { type: 'tool_use', id: part.callId, name: part.tool, input: part.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.callId,
        content: part.content,
        is_error: part.isError,
      };
  }
};

/**
 * Lê os bytes dos Anexos aqui, para viverem só até o corpo da requisição sair.
 * Sem `thinking`, os Modelos atuais raciocinam de forma adaptativa no Esforço dado.
 * Todo pedido liga o cache de prompt, no TTL padrão de 5 min (ADR 0012).
 */
export const toAnthropicPayload = async (
  request: ChatRequest,
  thinking: ThinkingOff | null,
): Promise<AnthropicPayload> => ({
  model: request.model,
  max_tokens: request.maxTokens,
  stream: true,
  cache_control: { type: 'ephemeral' },
  ...(request.system === null ? {} : { system: request.system }),
  ...(thinking === null ? {} : { thinking }),
  output_config: { effort: request.effort },
  ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toTool) }),
  messages: await Promise.all(
    request.messages.map(async (message) => ({
      role: message.role,
      content: await Promise.all(message.parts.map(toContentBlock)),
    })),
  ),
});

/** Headers do Protocolo; autenticação e acesso pelo navegador são do Provedor. */
export const ANTHROPIC_MESSAGES_HEADERS = { 'anthropic-version': '2026-10-21' } as const;
