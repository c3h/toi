import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/adapters/http/sse';
import { collect, streamOf } from './helpers';

describe('parseSse', () => {
  it('lê o nome do evento e junta várias linhas de data', async () => {
    const body = streamOf([
      'event: content_block_delta\ndata: {"type":"text_delta",\ndata: "text":"oi"}\n\n',
    ]);

    await expect(collect(parseSse(body))).resolves.toEqual([
      { event: 'content_block_delta', data: '{"type":"text_delta",\n"text":"oi"}' },
    ]);
  });

  it('ignora comentários e aceita CRLF', async () => {
    const body = streamOf([': keep-alive\r\nevent: ping\r\ndata: {}\r\n\r\n']);

    await expect(collect(parseSse(body))).resolves.toEqual([{ event: 'ping', data: '{}' }]);
  });

  it('emite o último frame mesmo sem linha em branco no fim', async () => {
    const body = streamOf(['event: message_stop\ndata: {"type":"message_stop"}']);

    await expect(collect(parseSse(body))).resolves.toEqual([
      { event: 'message_stop', data: '{"type":"message_stop"}' },
    ]);
  });

  it('não quebra quando um caractere UTF-8 chega cortado entre chunks', async () => {
    const payload = 'event: delta\ndata: {"text":"olá 🐟 fim"}\n\n';
    const bytes = new TextEncoder().encode(payload);
    const expected = await collect(parseSse(streamOf([payload])));

    for (let split = 1; split < bytes.length; split += 1) {
      const frames = await collect(
        parseSse(streamOf([bytes.slice(0, split), bytes.slice(split)])),
      );
      expect(frames, `corte no byte ${split}`).toEqual(expected);
    }
  });

  it('cancela o corpo quando o consumidor para antes do fim', async () => {
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: x\ndata: 1\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    const iterator = parseSse(body);
    await iterator.next();
    await iterator.return(undefined);

    expect(cancelled).toBe(true);
  });
});
