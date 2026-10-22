export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Parser de Server-Sent Events. Aceita CRLF, comentários, múltiplas linhas de
 * `data` e frames que chegam cortados no meio de um caractere UTF-8.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let completed = false;

  const dispatch = (): SseFrame | null => {
    if (data.length === 0) {
      event = '';
      return null;
    }

    const frame: SseFrame = { event: event || 'message', data: data.join('\n') };
    event = '';
    data = [];
    return frame;
  };

  const consumeLine = (line: string): SseFrame | null => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (clean === '') return dispatch();
    if (clean.startsWith(':')) return null;

    const colon = clean.indexOf(':');
    const field = colon === -1 ? clean : clean.slice(0, colon);
    let value = colon === -1 ? '' : clean.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    if (field === 'data') data.push(value);

    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        const frame = consumeLine(line);
        if (frame) yield frame;

        newline = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const frame = consumeLine(buffer);
      if (frame) yield frame;
      buffer = '';
    }

    const last = dispatch();
    if (last) yield last;

    completed = true;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // O corpo já pode ter sido fechado pelo abort ou pela rede.
      }
    }

    reader.releaseLock();
  }
}
