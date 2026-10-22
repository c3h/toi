import { truncatedError } from '../../../domain/error';
import type { DeltaKind, PartStart, StreamEvent } from '../../../domain/stream';
import { emptyUsage, type StopReason, type Usage } from '../../../domain/usage';
import { parseSse } from '../../http/sse';
import type { AnthropicMessagesErrors } from './error';
import type {
  AnthropicStreamEvent,
  AnthropicUsage,
  ContentBlockDeltaEvent,
  ContentBlockStartEvent,
} from './types';

const stopReason = (value: string | null | undefined): StopReason => {
  switch (value) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'refusal':
    case 'pause_turn':
      return value;
    default:
      return 'unknown';
  }
};

const mergeInputUsage = (usage: Usage, raw: AnthropicUsage): void => {
  usage.inputTokens = raw.input_tokens ?? usage.inputTokens;
  usage.cacheCreationInputTokens = raw.cache_creation_input_tokens ?? usage.cacheCreationInputTokens;
  usage.cacheReadInputTokens = raw.cache_read_input_tokens ?? usage.cacheReadInputTokens;
};

/** O bloco que o domínio conhece; `null` para tipo novo, que é ignorado. */
const partStart = (block: ContentBlockStartEvent['content_block']): PartStart | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text' };
    case 'thinking':
      return { type: 'reasoning' };
    case 'redacted_thinking':
      return typeof block.data === 'string' ? { type: 'redacted_reasoning', data: block.data } : null;
    case 'tool_use':
      return typeof block.id === 'string' && typeof block.name === 'string'
        ? { type: 'tool_call', callId: block.id, tool: block.name }
        : null;
    default:
      return null;
  }
};

const deltaOf = (
  delta: ContentBlockDeltaEvent['delta'],
): { part: DeltaKind; text: string } | null => {
  switch (delta.type) {
    case 'text_delta':
      return typeof delta.text === 'string' ? { part: 'text', text: delta.text } : null;
    case 'thinking_delta':
      return typeof delta.thinking === 'string' ? { part: 'reasoning', text: delta.thinking } : null;
    case 'signature_delta':
      return typeof delta.signature === 'string' ? { part: 'signature', text: delta.signature } : null;
    case 'input_json_delta':
      return typeof delta.partial_json === 'string' ? { part: 'input', text: delta.partial_json } : null;
    default:
      return null;
  }
};

export async function* mapAnthropicStream(
  body: ReadableStream<Uint8Array>,
  errors: AnthropicMessagesErrors,
): AsyncGenerator<StreamEvent> {
  const usage = emptyUsage();
  const openBlocks = new Set<number>();
  let finished = false;

  for await (const frame of parseSse(body)) {
    if (!frame.data) continue;

    let payload: AnthropicStreamEvent;
    try {
      payload = JSON.parse(frame.data) as AnthropicStreamEvent;
    } catch (cause) {
      throw errors.unreadable(cause);
    }

    switch (payload.type) {
      case 'message_start': {
        mergeInputUsage(usage, payload.message.usage);

        yield { type: 'started', model: payload.message.model, usage: { ...usage } };
        break;
      }

      case 'content_block_start': {
        const part = partStart(payload.content_block);
        if (part === null) break;

        openBlocks.add(payload.index);
        yield { type: 'part_started', index: payload.index, part };
        break;
      }

      case 'content_block_delta': {
        if (!openBlocks.has(payload.index)) break;
        const delta = deltaOf(payload.delta);
        if (delta === null) break;

        yield { type: 'delta', index: payload.index, ...delta };
        break;
      }

      case 'content_block_stop': {
        if (!openBlocks.delete(payload.index)) break;
        yield { type: 'part_finished', index: payload.index };
        break;
      }

      case 'message_delta': {
        if (payload.usage) {
          usage.outputTokens = payload.usage.output_tokens ?? usage.outputTokens;
          mergeInputUsage(usage, payload.usage);
        }

        yield {
          type: 'usage',
          usage: { ...usage },
          stopReason: stopReason(payload.delta.stop_reason),
        };
        break;
      }

      case 'message_stop': {
        finished = true;
        yield { type: 'finished' };
        break;
      }

      case 'error': {
        throw errors.fromEvent(payload.error);
      }

      case 'ping': {
        break;
      }
    }
  }

  if (!finished) {
    throw truncatedError();
  }
}
