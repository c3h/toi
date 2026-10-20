import type { Model } from '../domain/model';
import type { StreamEvent } from '../domain/stream';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  maxTokens: number;
  messages: ChatMessage[];
}

export interface ChatProvider {
  listModels(signal: AbortSignal): Promise<Model[]>;
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}
