import { describe, expect, it } from 'vitest';
import { createFlow } from '../src/app/flow';
import { textOf } from '../src/domain/message';
import {
  baseDeps,
  gatedProvider,
  replyEvents,
  ScriptedProvider,
  sendInput,
} from './helpers';

describe('createFlow', () => {
  it('flush grava o rascunho sem esperar o intervalo', async () => {
    const { store, deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const flow = createFlow({ ...deps, provider: () => provider });

    const pending = flow.send(sendInput());

    await delta;
    expect(flow.active()).toBe('c1');

    await flow.flush();

    const messages = await store.listMessages('c1');
    expect(messages).toHaveLength(2);
    expect(textOf(messages[1]!)).toBe('a');
    expect(messages[1]?.status).toBe('streaming');

    await flow.stop();
    const result = await pending;

    expect(result.message.status).toBe('interrupted');
    expect(flow.active()).toBeNull();
  });

  it('stop antes do Fluxo começar fecha em interrupted', async () => {
    const { store, deps } = await baseDeps();
    const provider = new ScriptedProvider(replyEvents());
    const flow = createFlow({ ...deps, provider: () => provider });

    const pending = flow.send(sendInput());
    await flow.stop();

    const result = await pending;
    expect(result.message.status).toBe('interrupted');
    expect(flow.active()).toBeNull();
    expect((await store.listMessages('c1')).at(-1)?.status).toBe('interrupted');
  });

  it('recusa um Fluxo na mesma Conversa enquanto outra aba a usa', async () => {
    const { deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const tabA = createFlow({ ...deps, provider: () => provider });
    const tabB = createFlow({ ...deps, provider: () => provider });

    const pending = tabA.send(sendInput());
    await delta;

    await expect(
      tabB.send(sendInput({ text: 'Outra' })),
    ).rejects.toMatchObject({ code: 'flow_busy' });
    expect(tabB.active()).toBeNull();

    await tabA.stop();
    await pending;
  });
});
