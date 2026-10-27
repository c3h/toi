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
      { type: 'part_started', index: 0, part: { type: 'text' } },
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

  it('traduz raciocínio, signature, raciocínio cifrado e chamada de Ferramenta', async () => {
    const block = (index: number, content_block: object) => ({
      event: 'content_block_start',
      data: { type: 'content_block_start', index, content_block },
    });
    const delta = (index: number, value: object) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index, delta: value },
    });
    const stop = (index: number) => ({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index },
    });

    const body = sse([
      block(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'pensando' }),
      delta(0, { type: 'signature_delta', signature: 'sig' }),
      stop(0),
      block(1, { type: 'redacted_thinking', data: 'cifrado' }),
      stop(1),
      block(2, { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} }),
      delta(2, { type: 'input_json_delta', partial_json: '{"query":' }),
      delta(2, { type: 'input_json_delta', partial_json: '"cobre"}' }),
      stop(2),
      block(3, { type: 'server_tool_use', id: 'srv', name: 'futuro' }),
      delta(3, { type: 'input_json_delta', partial_json: '{}' }),
      stop(3),
      {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    const events = await collect(map(streamOf([body])));

    expect(events.filter((event) => event.type !== 'usage')).toEqual([
      { type: 'part_started', index: 0, part: { type: 'reasoning' } },
      { type: 'delta', index: 0, part: 'reasoning', text: 'pensando' },
      { type: 'delta', index: 0, part: 'signature', text: 'sig' },
      { type: 'part_finished', index: 0 },
      { type: 'part_started', index: 1, part: { type: 'redacted_reasoning', data: 'cifrado' } },
      { type: 'part_finished', index: 1 },
      {
        type: 'part_started',
        index: 2,
        part: { type: 'tool_call', callId: 'toolu_1', tool: 'web_search' },
      },
      { type: 'delta', index: 2, part: 'input', text: '{"query":' },
      { type: 'delta', index: 2, part: 'input', text: '"cobre"}' },
      { type: 'part_finished', index: 2 },
      { type: 'finished' },
    ]);
    expect(events.find((event) => event.type === 'usage')).toMatchObject({ stopReason: 'tool_use' });
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
