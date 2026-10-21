import type { Part } from '../domain/message';
import type { Model } from '../domain/model';
import type { StreamEvent } from '../domain/stream';

/** Carrega Partes, não texto: raciocínio, imagem e ferramentas entram sem mudar a porta. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: Part[];
}

export interface ChatRequest {
  model: string;
  maxTokens: number;
  messages: ChatMessage[];
  /** Instrução de sistema; campo próprio, nunca uma Mensagem. */
  system?: string;
  temperature?: number;
}

/**
 * Contrato do Provedor. `listModels` também valida a Chave; `stream` deve
 * terminar com o Evento `finished` — o consumidor trata a ausência como
 * `unreachable`. O adaptador não grava, não retém histórico e não decide UI.
 */
export interface ChatProvider {
  listModels(signal: AbortSignal): Promise<Model[]>;
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}
