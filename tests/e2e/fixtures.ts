import { test as base, expect, type Page } from '@playwright/test';

export interface MockOptions {
  /** Texto da resposta, emitido em `deltas` pedaços. */
  reply: string;
  deltas: number;
  /** Intervalo entre deltas; o Fluxo fica aberto enquanto isso. */
  delayMs: number;
}

declare global {
  interface Window {
    __mock: MockOptions;
    __requests: number;
  }
}

/**
 * Substitui `fetch` só para api.anthropic.com antes de o app carregar. O resto
 * da página roda de verdade: IndexedDB, Web Locks, Markdown e Shiki.
 */
const installMock = () => {
  const real = window.fetch.bind(window);
  const encoder = new TextEncoder();
  const frame = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  window.__mock = { reply: 'Olá.', deltas: 1, delayMs: 0 };
  window.__requests = 0;

  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.anthropic.com')) return real(input, init);

    if (url.includes('/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              type: 'model',
              id: 'claude-sonnet-teste',
              display_name: 'Claude Sonnet Teste',
              created_at: '2026-01-01T00:00:00Z',
              max_tokens: 8192,
              max_input_tokens: 200000,
              capabilities: {
                effort: {
                  supported: true,
                  low: { supported: true },
                  medium: { supported: true },
                  high: { supported: true },
                  xhigh: { supported: true },
                  max: { supported: true },
                },
              },
            },
          ],
          has_more: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    window.__requests += 1;
    const { reply, deltas, delayMs } = window.__mock;
    const size = Math.ceil(reply.length / deltas);
    const signal = init?.signal;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          frame('message_start', {
            type: 'message_start',
            message: { model: 'claude-sonnet-teste', usage: { input_tokens: 12, output_tokens: 1 } },
          }),
        );
        controller.enqueue(
          frame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        );

        for (let offset = 0; offset < reply.length; offset += size) {
          if (signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          controller.enqueue(
            frame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: reply.slice(offset, offset + size) },
            }),
          );
        }

        controller.enqueue(frame('content_block_stop', { type: 'content_block_stop', index: 0 }));
        controller.enqueue(
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: deltas },
          }),
        );
        controller.enqueue(frame('message_stop', { type: 'message_stop' }));
        controller.close();
      },
    });

    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
};

export const setMock = (page: Page, options: Partial<MockOptions>) =>
  page.evaluate((patch) => Object.assign(window.__mock, patch), options);

export const connect = async (page: Page) => {
  await page.goto('/');
  await page.getByLabel('chave da api').fill('sk-ant-teste');
  await page.getByRole('button', { name: 'conectar' }).click();
  await expect(page.getByLabel('mensagem')).toBeVisible();
};

export const send = async (page: Page, text: string) => {
  await page.getByLabel('mensagem').fill(text);
  await page.getByLabel('mensagem').press('Enter');
};

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(installMock);
    await use(context);
  },
});

export { expect };
