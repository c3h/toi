import { describe, expect, it } from 'vitest';
import { createFlow } from '../src/app/flow';
import { textOf } from '../src/domain/message';
import {
  baseDeps,
  gatedProvider,
  gatedStreams,
  makeConversation,
  replyEvents,
  ScriptedProvider,
  sendInput,
} from './helpers';

describe('createFlow', () => {
  it('flush grava o rascunho sem esperar o intervalo', async () => {
    const { store, deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const flow = createFlow({ ...deps, provider: () => provider, tools: () => null });

    const pending = flow.send(sendInput());

    await delta;
    expect(flow.active()).toEqual(new Set(['c1']));

    await flow.flush();

    const messages = await store.listMessages('c1');
    expect(messages).toHaveLength(2);
    expect(textOf(messages[1]!)).toBe('a');
    expect(messages[1]?.status).toBe('streaming');

    await flow.stop('c1');
    const result = await pending;

    expect(result.message.status).toBe('interrupted');
    expect(flow.active().size).toBe(0);
  });

  it('stop antes do Fluxo começar fecha em interrupted', async () => {
    const { store, deps } = await baseDeps();
    const provider = new ScriptedProvider(replyEvents());
    const flow = createFlow({ ...deps, provider: () => provider, tools: () => null });

    const pending = flow.send(sendInput());
    await flow.stop('c1');

    const result = await pending;
    expect(result.message.status).toBe('interrupted');
    expect(flow.active().size).toBe(0);
    expect((await store.listMessages('c1')).at(-1)?.status).toBe('interrupted');
  });

  it('recusa um Fluxo na mesma Conversa enquanto outra aba a usa', async () => {
    const { deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const tabA = createFlow({ ...deps, provider: () => provider, tools: () => null });
    const tabB = createFlow({ ...deps, provider: () => provider, tools: () => null });

    const pending = tabA.send(sendInput());
    await delta;

    await expect(
      tabB.send(sendInput({ text: 'Outra' })),
    ).rejects.toMatchObject({ code: 'flow_busy' });
    expect(tabB.active().size).toBe(0);

    await tabA.stop('c1');
    await pending;
  });

  /** Flow com as Conversas c1 e c2; cada pedido emite o próprio texto. */
  const parallel = async () => {
    const { store, deps } = await baseDeps();
    await store.putConversation(makeConversation('c2'));
    const { provider, delta } = gatedStreams();
    const flow = createFlow({ ...deps, provider: () => provider, tools: () => null });
    return { store, flow, delta };
  };

  it('Conversas diferentes respondem em paralelo; a mesma Conversa recusa', async () => {
    const { store, flow, delta } = await parallel();

    const first = flow.send(sendInput());
    await delta(0);
    const second = flow.send(sendInput({ conversationId: 'c2' }));
    await delta(1);

    expect(flow.active()).toEqual(new Set(['c1', 'c2']));
    await expect(flow.send(sendInput({ text: 'Outra' }))).rejects.toMatchObject({
      code: 'flow_busy',
    });

    await flow.flush();
    expect(textOf((await store.listMessages('c1'))[1]!)).toBe('r0');
    expect(textOf((await store.listMessages('c2'))[1]!)).toBe('r1');

    // Parar uma não toca a outra, que segue em Fluxo.
    await flow.stop('c1');
    expect((await first).message.status).toBe('interrupted');
    expect(flow.active()).toEqual(new Set(['c2']));
    expect((await store.listMessages('c2'))[1]?.status).toBe('streaming');

    await flow.stop('c2');
    expect((await second).message.status).toBe('interrupted');
    expect(flow.active().size).toBe(0);
  });

  it('exclusive sem Conversa para todos os Fluxos; com Conversa, só o dela', async () => {
    const { flow, delta } = await parallel();

    const first = flow.send(sendInput());
    const second = flow.send(sendInput({ conversationId: 'c2' }));
    await Promise.all([delta(0), delta(1)]);

    await flow.exclusive(async () => {
      expect(flow.active()).toEqual(new Set(['c2']));
      await expect(flow.send(sendInput())).rejects.toMatchObject({ code: 'flow_busy' });
    }, 'c1');
    expect((await first).message.status).toBe('interrupted');

    await flow.exclusive(async () => {
      expect(flow.active().size).toBe(0);
      await expect(
        flow.send(sendInput({ conversationId: 'c2' })),
      ).rejects.toMatchObject({ code: 'flow_busy' });
    });
    expect((await second).message.status).toBe('interrupted');
  });

  it('active só muda de identidade quando um Fluxo começa ou termina, e watch avisa', async () => {
    const { deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const flow = createFlow({ ...deps, provider: () => provider, tools: () => null });
    const changes: Array<ReadonlySet<string>> = [];
    const unwatch = flow.watch(() => changes.push(flow.active()));
    const idle = flow.active();

    const pending = flow.send(sendInput());
    expect(changes).toEqual([new Set(['c1'])]);
    await delta;
    await flow.flush();
    expect(changes).toHaveLength(1);
    expect(flow.active()).toBe(changes[0]);

    await flow.stop('c1');
    await pending;
    expect(changes).toHaveLength(2);
    expect(flow.active().size).toBe(0);
    expect(flow.active()).not.toBe(idle);

    unwatch();
  });
});
