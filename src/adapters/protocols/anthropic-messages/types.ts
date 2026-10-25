export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface MessageStartEvent {
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
    /** `redacted_thinking`. */
    data?: string;
    /** `tool_use`. */
    id?: string;
    name?: string;
  };
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
  };
}

interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
}

interface MessageStopEvent {
  type: 'message_stop';
}

interface PingEvent {
  type: 'ping';
}

interface ErrorEvent {
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
