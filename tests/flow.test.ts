import { describe, expect, it } from 'vitest';
import { createFlow } from '../src/app/flow';
import { appError } from '../src/domain/error';
import { textOf } from '../src/domain/message';
import type { StreamEvent } from '../src/domain/stream';
import {
  baseDeps,
  gatedProvider,
  replyEvents,
  ScriptedProvider,
  testModel,
  usage,
} from './helpers';

describe('createFlow', () => {
  it('flush grava o rascunho sem esperar o intervalo', async () => {
    const { store, deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const flow = createFlow({ ...deps, provider: () => provider });

    const pending = flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });

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

  it('stop fecha o Fluxo em interrupted e desmarca o estado ativo', async () => {
    const { deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const flow = createFlow({ ...deps, provider: () => provider });

    const pending = flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
    await delta;
    await flow.stop();

    const result = await pending;
    expect(result.message.status).toBe('interrupted');
    expect(flow.active()).toBeNull();
  });

  it('recusa um segundo Fluxo enquanto o primeiro está ativo', async () => {
    const { deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const flow = createFlow({ ...deps, provider: () => provider });

    const first = flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });

    await expect(
      flow.send({ conversationId: 'c1', text: 'Outra', model: testModel }),
    ).rejects.toMatchObject({ code: 'flow_busy' });

    await delta;
    await flow.stop();
    await first;
  });

  it('retry reusa a última Mensagem do assistant', async () => {
    const { deps } = await baseDeps();
    let failing = true;

    const provider = new ScriptedProvider(async function* (): AsyncGenerator<StreamEvent> {
      if (failing) {
        yield { type: 'started', model: testModel.id, usage: usage(3, 0) };
        throw appError('overloaded');
      }

      yield* replyEvents();
    });

    const flow = createFlow({ ...deps, provider: () => provider });

    const first = await flow.send({
      conversationId: 'c1',
      text: 'Pergunta',
      model: testModel,
    });

    expect(first.message.status).toBe('failed');

    failing = false;

    const retried = await flow.retry({
      conversationId: 'c1',
      messageId: first.message.id,
      model: testModel,
    });

    expect(retried.message.id).toBe(first.message.id);
    expect(retried.message.status).toBe('complete');
    expect(textOf(retried.message)).toBe('Olá');
  });

  it('stop antes do Fluxo começar fecha em interrupted', async () => {
    const { store, deps } = await baseDeps();
    const provider = new ScriptedProvider(replyEvents());
    const flow = createFlow({ ...deps, provider: () => provider });

    const pending = flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
    await flow.stop();

    const result = await pending;
    expect(result.message.status).toBe('interrupted');
    expect(flow.active()).toBeNull();
    expect((await store.listMessages('c1')).at(-1)?.status).toBe('interrupted');
  });

  it('recusa send sem Provedor', async () => {
    const { deps } = await baseDeps();
    const flow = createFlow({ ...deps, provider: () => null });

    await expect(
      flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel }),
    ).rejects.toMatchObject({ code: 'not_connected' });
    expect(flow.active()).toBeNull();
  });

  it('exclusive recusa novos Fluxos enquanto a tarefa roda', async () => {
    const { deps } = await baseDeps();
    const provider = new ScriptedProvider(replyEvents());
    const flow = createFlow({ ...deps, provider: () => provider });

    let release: () => void = () => undefined;
    const task = flow.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await expect(
      flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel }),
    ).rejects.toMatchObject({ code: 'flow_busy' });

    release();
    await task;

    const result = await flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
    expect(result.message.status).toBe('complete');
  });

  it('exclusive de outra Conversa não para o Fluxo em voo', async () => {
    const { deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const flow = createFlow({ ...deps, provider: () => provider });

    const pending = flow.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
    await delta;

    await flow.exclusive(async () => undefined, 'c2');
    expect(flow.active()).toBe('c1');

    await flow.stop();
    await pending;
  });

  it('recusa um Fluxo na mesma Conversa enquanto outra aba a usa', async () => {
    const { deps } = await baseDeps();
    const { provider, delta } = gatedProvider();
    const tabA = createFlow({ ...deps, provider: () => provider });
    const tabB = createFlow({ ...deps, owner: 'tab-b', provider: () => provider });

    const pending = tabA.send({ conversationId: 'c1', text: 'Pergunta', model: testModel });
    await delta;

    await expect(
      tabB.send({ conversationId: 'c1', text: 'Outra', model: testModel }),
    ).rejects.toMatchObject({ code: 'flow_busy' });
    expect(tabB.active()).toBeNull();

    await tabA.stop();
    await pending;
  });

  it('libera a Conversa para outra aba quando o Fluxo fecha', async () => {
    const { store, deps } = await baseDeps();
    const tabA = createFlow({ ...deps, provider: () => new ScriptedProvider(replyEvents()) });
    const tabB = createFlow({
      ...deps,
      owner: 'tab-b',
      provider: () => new ScriptedProvider(replyEvents()),
    });

    await tabA.send({ conversationId: 'c1', text: 'Primeira', model: testModel });
    const second = await tabB.send({ conversationId: 'c1', text: 'Segunda', model: testModel });

    expect(second.message.status).toBe('complete');
    expect((await store.listMessages('c1')).map((message) => message.seq)).toEqual([1, 2, 3, 4]);
  });
});
