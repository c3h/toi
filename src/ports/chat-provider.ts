import type { Attachment } from '../domain/attachment';
import type { ProviderId } from '../domain/ids';
import type { JsonObject } from '../domain/json';
import type { Effort, Model } from '../domain/model';
import type { StreamEvent } from '../domain/stream';

/**
 * Uma Parte como vai ao Provedor: o Anexo com o Blob do store, que o adapter
 * lê só ao montar o corpo e traduz no bloco que a API dá a cada tipo.
 */
export type OutgoingPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature: string }
  | { type: 'redacted_reasoning'; data: string }
  | { type: 'file'; attachment: Attachment; data: Blob }
  | { type: 'tool_call'; callId: string; tool: string; input: JsonObject }
  | { type: 'tool_result'; callId: string; content: string; isError: boolean };

/** Uma Ferramenta oferecida ao Modelo; `inputSchema` é JSON Schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

/** Carrega Partes, não texto: raciocínio, Anexos e Ferramentas entram sem mudar a porta. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: OutgoingPart[];
}

export interface ChatRequest {
  model: string;
  maxTokens: number;
  effort: Effort;
  messages: ChatMessage[];
  /** Instrução de sistema; campo próprio, nunca uma Mensagem. */
  system?: string;
  /** Vazio quando o toi não oferece Ferramentas. */
  tools: ToolDefinition[];
}

/**
 * Contrato do Provedor. `listModels` também valida a Chave e só devolve
 * Modelos que aceitam todo `Effort`, porque todo envio leva um; `stream` deve
 * terminar com o Evento `finished` — o consumidor trata a ausência como
 * `unreachable`. O adaptador não grava, não retém histórico e não decide UI.
 */
export interface ChatProvider {
  listModels(signal: AbortSignal): Promise<Model[]>;
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

/**
 * O que a UI pode saber de um Provedor: nome e onde conseguir a Chave.
 * Nunca endpoint, header ou Protocolo. As formas com artigo existem porque
 * a copy em português contrai a preposição: "da Anthropic", "do Google".
 */
export interface ProviderInfo {
  id: ProviderId;
  /** "a Anthropic", "o Google". */
  the: string;
  /** "da Anthropic", "do Google". */
  of: string;
  /** "à Anthropic", "ao Google". */
  to: string;
  keyPlaceholder: string;
  keysUrl: string;
  /** Famílias que o seletor oferece até a pessoa mexer na lista. */
  defaultFamilies: string[];
}

/** Um Provedor registrado no composition root: o descritor e como conectar com uma Chave. */
export interface ProviderAdapter {
  info: ProviderInfo;
  create(apiKey: string): ChatProvider;
}
