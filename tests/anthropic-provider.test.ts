import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/adapters/http/fetch';
import { toAnthropicPayload } from '../src/adapters/protocols/anthropic-messages/request';
import { AnthropicProvider } from '../src/adapters/providers/anthropic/provider';
import type { AttachmentUpload } from '../src/domain/attachment';
import type { OutgoingPart } from '../src/ports/chat-provider';
import { collect, imageFile, pdfFile, sse, streamOf, textFile } from './helpers';

const sent = ({ attachment }: AttachmentUpload, content: BlobPart): OutgoingPart => ({
  type: 'file',
  attachment,
  data: new Blob([content]),
});

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
          reasoning: 'on',
          tools: [],
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

  it('manda imagem e PDF em base64 e texto de arquivo como documento com título', async () => {
    const payload = await toAnthropicPayload(
      {
        model: 'claude-test',
        maxTokens: 128,
        effort: 'low',
        reasoning: 'on',
        tools: [],
        messages: [
          {
            role: 'user',
            parts: [
              sent(imageFile('foto'), new Uint8Array([1, 2, 3])),
              sent(pdfFile('contrato'), '%PDF-'),
              sent(textFile('notas'), '# oi'),
              { type: 'text', text: 'resuma' },
            ],
          },
        ],
      },
      null,
    );

    expect(payload.messages[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      {
        type: 'document',
        title: 'contrato.pdf',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
      },
      {
        type: 'document',
        title: 'notas.txt',
        source: { type: 'text', media_type: 'text/plain', data: '# oi' },
      },
      { type: 'text', text: 'resuma' },
    ]);
  });

  it('manda as Ferramentas e as Rodadas com raciocínio, chamada e resultado', async () => {
    const payload = await toAnthropicPayload(
      {
        model: 'claude-test',
        maxTokens: 128,
        effort: 'low',
        reasoning: 'on',
        tools: [{ name: 'web_search', description: 'Busca.', inputSchema: { type: 'object' } }],
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'cobre hoje?' }] },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: 'buscar', signature: 'sig' },
              { type: 'redacted_reasoning', data: 'cifrado' },
              { type: 'tool_call', callId: 't1', tool: 'web_search', input: { query: 'cobre' } },
            ],
          },
          {
            role: 'user',
            parts: [{ type: 'tool_result', callId: 't1', content: 'Error: x', isError: true }],
          },
        ],
      },
      null,
    );

    expect(payload.tools).toEqual([
      { name: 'web_search', description: 'Busca.', input_schema: { type: 'object' } },
    ]);
    expect(payload.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'buscar', signature: 'sig' },
          { type: 'redacted_thinking', data: 'cifrado' },
          { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'cobre' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: x', is_error: true }],
      },
    ]);
  });

  it('raciocínio desligado vira o `thinking` que cada Modelo aceita', async () => {
    const thinkingFor = async (model: string) => {
      let body = '';
      const fetchImpl: FetchLike = async (_, init) => {
        body = init?.body as string;
        return new Response(
          streamOf([sse([{ event: 'message_stop', data: { type: 'message_stop' } }])]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      };
      await collect(
        new AnthropicProvider('sk-test', fetchImpl).stream(
          {
            model,
            maxTokens: 64,
            effort: 'low',
            reasoning: 'off',
            tools: [],
            messages: [{ role: 'user', parts: [{ type: 'text', text: 'oi' }] }],
          },
          new AbortController().signal,
        ),
      );
      return JSON.parse(body).thinking;
    };

    expect(await thinkingFor('claude-haiku-5-5')).toEqual({ type: 'disabled' });
    expect(await thinkingFor('claude-sonnet-5-5')).toEqual({ type: 'between_tools' });
    // Opus 5.5 e Fable recusam desligar: o pedido vai sem `thinking`, no Esforço dado.
    expect(await thinkingFor('claude-opus-5-5')).toBeUndefined();
  });
});
