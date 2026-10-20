import { AppError } from '../../domain/error';
import type { StreamEvent } from '../../domain/stream';
import { emptyUsage, type StopReason, type Usage } from '../../domain/usage';
import { errorFromEvent, unreadableError } from './error';
import { parseSse } from './sse';
import type { AnthropicStreamEvent, AnthropicUsage } from './types';

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

export async function* mapAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const usage = emptyUsage();
  const textBlocks = new Set<number>();
  let finished = false;

  for await (const frame of parseSse(body)) {
    if (!frame.data) continue;

    let payload: AnthropicStreamEvent;
    try {
      payload = JSON.parse(frame.data) as AnthropicStreamEvent;
    } catch (cause) {
      throw unreadableError(cause);
    }

    switch (payload.type) {
      case 'message_start': {
        mergeInputUsage(usage, payload.message.usage);

        yield { type: 'started', model: payload.message.model, usage: { ...usage } };
        break;
      }

      case 'content_block_start': {
        if (payload.content_block.type === 'text') {
          textBlocks.add(payload.index);
          yield { type: 'part_started', index: payload.index, part: 'text' };
        }
        break;
      }

      case 'content_block_delta': {
        if (!textBlocks.has(payload.index)) break;
        if (payload.delta.type !== 'text_delta' || typeof payload.delta.text !== 'string') break;

        yield {
          type: 'delta',
          index: payload.index,
          part: 'text',
          text: payload.delta.text,
        };
        break;
      }

      case 'content_block_stop': {
        if (!textBlocks.delete(payload.index)) break;
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
        throw errorFromEvent(payload.error);
      }

      case 'ping': {
        break;
      }
    }
  }

  if (!finished) {
    throw new AppError('unreachable', 'A resposta terminou antes do fim.');
  }
}
