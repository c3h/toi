import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/adapters/http/fetch';
import { AnthropicProvider } from '../src/adapters/providers/anthropic/provider';
import { toAnthropicPayload } from '../src/adapters/protocols/anthropic-messages/request';
import { collect, sse, streamOf } from './helpers';

describe('AnthropicProvider', () => {
  it('monta o POST com headers obrigatórios, Esforço e payload de texto', async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;

    const fetchImpl: FetchLike = async (input, init) => {
      captured = { url: String(input), init };
      return new Response(
        streamOf([sse([{ event: 'message_stop', data: { type: 'message_stop' } }])]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    const provider = new AnthropicProvider('sk-test', fetchImpl);

    const events = await collect(
      provider.stream(
        {
          model: 'claude-test',
          maxTokens: 128,
          effort: 'low',
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'oi' }] }],
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([{ type: 'finished' }]);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured!.init?.method).toBe('POST');
    expect(captured!.init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-api-key': 'sk-test',
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(JSON.parse(captured!.init?.body as string)).toEqual({
      model: 'claude-test',
      max_tokens: 128,
      stream: true,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
    });
  });

  it('mapeia system, Esforço e raciocínio para o formato da Anthropic', () => {
    expect(
      toAnthropicPayload({
        model: 'claude-test',
        maxTokens: 128,
        effort: 'xhigh',
        system: 'Seja breve.',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'oi' }] },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: 'pensando', signature: 'sig' },
              { type: 'text', text: 'olá' },
            ],
          },
        ],
      }),
    ).toEqual({
      model: 'claude-test',
      max_tokens: 128,
      stream: true,
      system: 'Seja breve.',
      output_config: { effort: 'xhigh' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'oi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'pensando', signature: 'sig' },
            { type: 'text', text: 'olá' },
          ],
        },
      ],
    });
  });
});
