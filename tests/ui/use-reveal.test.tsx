import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import type { MessageStatus } from '../../src/domain/message';
import { useReveal } from '../../src/ui/use-reveal';

interface Props {
  text: string;
  status: MessageStatus;
}

const FRAME_MS = 16;

const mount = (text: string, status: MessageStatus) =>
  renderHook((props?: Props) => useReveal(props!.text, props!.status), {
    initialProps: { text, status },
  });

type Hook = Awaited<ReturnType<typeof mount>>;

/** Avança `ms` frame a frame e devolve `waiting` de cada um. */
const frames = async (hook: Hook, ms: number): Promise<boolean[]> => {
  const seen: boolean[] = [];
  for (let at = 0; at < ms; at += FRAME_MS) {
    await hook.act(() => vi.advanceTimersByTime(FRAME_MS));
    seen.push(hook.result.current.waiting);
  }
  return seen;
};

describe('useReveal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mostra o cursor antes do primeiro token e com o texto parado, não com ele correndo', async () => {
    const hook = await mount('', 'streaming');
    expect(hook.result.current.waiting).toBe(true);

    const text = 'Era uma vez uma menina que subia a colina.';
    await hook.rerender({ text, status: 'streaming' });
    expect(hook.result.current.waiting).toBe(false);

    while (hook.result.current.shown !== text) {
      await hook.act(() => vi.advanceTimersByTime(FRAME_MS));
      expect(hook.result.current.waiting).toBe(false);
    }

    // Tudo à vista, mas o cursor ainda espera o texto ficar parado.
    expect(await frames(hook, 350)).not.toContain(true);
    await hook.act(() => vi.advanceTimersByTime(100));
    expect(hook.result.current.waiting).toBe(true);

    // Chegou mais: o cursor some já no render do texto novo.
    await hook.rerender({ text: `${text} Desde ali,`, status: 'streaming' });
    expect(hook.result.current.waiting).toBe(false);

    await hook.rerender({ text: `${text} Desde ali, via tudo.`, status: 'complete' });
    expect(await frames(hook, 1000)).not.toContain(true);
  });

  it('não pisca o cursor entre rajadas de um Fluxo rápido', async () => {
    const hook = await mount('', 'streaming');
    let text = '';
    const seen: boolean[] = [];

    // 800 caracteres por segundo em rajadas a cada 300 ms, como o Provedor entrega.
    for (let burst = 0; burst < 10; burst += 1) {
      text += 'palavra '.repeat(30);
      await hook.rerender({ text, status: 'streaming' });
      seen.push(...(await frames(hook, 300)));
    }

    expect(seen).not.toContain(true);
  });
});
