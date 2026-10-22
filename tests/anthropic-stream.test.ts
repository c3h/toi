import { describe, expect, it } from 'vitest';
import { mapAnthropicStream } from '../src/adapters/protocols/anthropic-messages/stream';
import { anthropicErrors } from '../src/adapters/providers/anthropic/info';
import { collect, sse, streamOf } from './helpers';

const map = (body: ReadableStream<Uint8Array>) => mapAnthropicStream(body, anthropicErrors);

const textStream = (): string =>
  sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { model: 'claude-test', usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Olá' },
      },
    },
    { event: 'ping', data: { type: 'ping' } },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ', mundo' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 7 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

describe('mapAnthropicStream', () => {
  it('traduz o stream em Eventos do domínio e faz merge do uso', async () => {
    const events = await collect(map(streamOf([textStream()])));

    expect(events).toEqual([
      {
        type: 'started',
        model: 'claude-test',
        usage: {
          inputTokens: 12,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 3,
        },
      },
      { type: 'part_started', index: 0, part: 'text' },
      { type: 'delta', index: 0, part: 'text', text: 'Olá' },
      { type: 'delta', index: 0, part: 'text', text: ', mundo' },
      { type: 'part_finished', index: 0 },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 3,
        },
        stopReason: 'end_turn',
      },
      { type: 'finished' },
    ]);
  });

  it('ignora raciocínio na v1', async () => {
    const body = sse([
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: { model: 'claude-test', usage: { input_tokens: 1 } },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'segredo' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'resposta' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    const events = await collect(map(streamOf([body])));

    expect(events.filter((event) => event.type === 'delta')).toEqual([
      { type: 'delta', index: 1, part: 'text', text: 'resposta' },
    ]);
  });

  it('ignora evento desconhecido', async () => {
    const body = sse([
      { event: 'future_event', data: { type: 'future_event', value: 1 } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    await expect(collect(map(streamOf([body])))).resolves.toEqual([
      { type: 'finished' },
    ]);
  });

  it('transforma evento de erro em AppError tipado', async () => {
    const body = sse([
      {
        event: 'error',
        data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      },
    ]);

    await expect(collect(map(streamOf([body])))).rejects.toMatchObject({
      code: 'overloaded',
    });
  });

  it('falha quando o stream termina sem message_stop', async () => {
    const body = sse([
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: { model: 'claude-test', usage: { input_tokens: 1 } },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'cortou' },
        },
      },
    ]);

    await expect(collect(map(streamOf([body])))).rejects.toMatchObject({
      code: 'unreachable',
    });
  });
});
