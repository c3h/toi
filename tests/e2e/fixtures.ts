import { test as base, expect, type Page } from '@playwright/test';

/** Um POST de `messages`, do lado da página: o que `HeldReply` lê e escreve. */
interface Held {
  body: string;
  write(text: string): void;
  pace(text: string, deltas: number, intervalMs: number): Promise<void>;
  end(): void;
}

declare global {
  interface Window {
    /** Cada POST de `messages`, na ordem, com a resposta aberta até o teste fechar. */
    __requests: Held[];
    /** Quantos deles algum `hold` já segura, feitos ou por fazer. */
    __held: number;
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

  window.__requests = [];
  window.__held = 0;

  const open = (body: string, signal: AbortSignal | null | undefined) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;
      },
    });
    // Como o `fetch` real: abortar depois dos headers quebra a leitura do corpo.
    signal?.addEventListener('abort', () =>
      controller.error(new DOMException('Aborted', 'AbortError')),
    );

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

    let written = 0;
    const held: Held = {
      body,
      write(text) {
        written += 1;
        controller.enqueue(
          frame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          }),
        );
      },
      async pace(text, deltas, intervalMs) {
        const size = Math.ceil(text.length / deltas);
        for (let offset = 0; offset < text.length; offset += size) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          held.write(text.slice(offset, offset + size));
        }
      },
      end() {
        controller.enqueue(frame('content_block_stop', { type: 'content_block_stop', index: 0 }));
        controller.enqueue(
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: written },
          }),
        );
        controller.enqueue(frame('message_stop', { type: 'message_stop' }));
        controller.close();
      },
    };

    return { stream, held };
  };

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

    const { stream, held } = open(typeof init?.body === 'string' ? init.body : '', init?.signal);
    window.__requests.push(held);

    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
};

export interface HeldReply {
  /** O corpo do POST, para conferir o que saiu da página. */
  body(): Promise<string>;
  /** Emite `text` num delta. */
  write(text: string): Promise<void>;
  /** Emite `text` em `deltas` pedaços, um a cada `intervalMs`; resolve com o último emitido. */
  pace(text: string, deltas: number, intervalMs: number): Promise<void>;
  /** Fecha a resposta com `end_turn` e um token de saída por delta. */
  end(): Promise<void>;
}

/**
 * Segura o próximo pedido de `messages` da página que nenhum `hold` segura,
 * feito ou por fazer: a resposta fica aberta, sem texto, até o teste escrever e
 * fechar. Toda resposta passa por aqui; o Fluxo em curso é o teste quem dita,
 * não o relógio: o que se faz no meio dele nunca chega tarde demais.
 */
export const hold = async (page: Page): Promise<HeldReply> => {
  const index = await page.evaluate(() => window.__held++);
  // O app pode ainda não ter feito o pedido que esta resposta segura.
  const requested = async () => {
    await page.waitForFunction((slot) => slot < window.__requests.length, index);
  };

  return {
    async body() {
      await requested();
      return page.evaluate((slot) => window.__requests[slot]!.body, index);
    },
    async write(text) {
      await requested();
      await page.evaluate(
        ([slot, piece]) => window.__requests[slot]!.write(piece),
        [index, text] as const,
      );
    },
    async pace(text, deltas, intervalMs) {
      await requested();
      await page.evaluate(
        ([slot, whole, count, interval]) => window.__requests[slot]!.pace(whole, count, interval),
        [index, text, deltas, intervalMs] as const,
      );
    },
    async end() {
      await requested();
      await page.evaluate((slot) => window.__requests[slot]!.end(), index);
    },
  };
};

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
