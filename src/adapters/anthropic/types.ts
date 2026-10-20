export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface MessageStartEvent {
  type: 'message_start';
  message: {
    model: string;
    usage: AnthropicUsage;
  };
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: string;
  };
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: string;
    text?: string;
  };
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
}

export interface MessageStopEvent {
  type: 'message_stop';
}

export interface PingEvent {
  type: 'ping';
}

export interface ErrorEvent {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

export type AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | ErrorEvent;

export interface AnthropicErrorEnvelope {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

export interface AnthropicModel {
  id: string;
  display_name?: string;
  max_tokens?: number | null;
  max_input_tokens?: number | null;
  created_at?: string;
  lifecycle?: 'active' | 'deprecated' | 'retired';
}

export interface AnthropicModelsPage {
  data: AnthropicModel[];
  has_more: boolean;
  last_id: string | null;
}
