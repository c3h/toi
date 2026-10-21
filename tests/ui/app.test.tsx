import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { MemoryLocks } from '../../src/adapters/locks/memory';
import { createToi } from '../../src/app/toi';
import type { ChatProvider } from '../../src/ports/chat-provider';
import { App } from '../../src/ui/App';
import {
  FailingProvider,
  gatedProvider,
  MemoryCredentialStore,
  MemorySettingsStore,
  MemoryStore,
  replyEvents,
  ScriptedProvider,
} from '../helpers';

const mount = async (createProvider: (key: string) => ChatProvider) => {
  sessionStorage.clear();
  let next = 0;
  const toi = await createToi({
    store: new MemoryStore(),
    credentials: new MemoryCredentialStore(),
    settings: new MemorySettingsStore(),
    clock: { now: () => Date.now() },
    estimator: { estimate: () => 1 },
    newId: () => `id-${(next += 1)}`,
    owner: 'tab',
    locks: new MemoryLocks(),
    createProvider,
  });
  return render(<App toi={toi} />);
};

const connect = async (screen: Awaited<ReturnType<typeof render>>, key = 'sk-test') => {
  await userEvent.fill(screen.getByLabelText('chave da api'), key);
  await userEvent.click(screen.getByRole('button', { name: 'conectar' }));
};

describe('App', () => {
  it('mostra o erro tipado e não sai do onboarding com Chave inválida', async () => {
    const screen = await mount(() => new FailingProvider([]));
    await connect(screen, 'sk-ruim');

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('chave inválida ou revogada.');
    await expect.element(screen.getByLabelText('chave da api')).toBeVisible();
  });

  it('conecta, envia e mostra a resposta com o uso', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents('**Olá**, tudo certo.')));
    await connect(screen);

    await userEvent.fill(screen.getByLabelText('mensagem'), 'Primeira pergunta');
    await userEvent.keyboard('{Enter}');

    await expect.element(screen.getByText('Primeira pergunta', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Olá')).toBeVisible();
    await expect.element(screen.getByText(/10 tokens de entrada/)).toBeVisible();
    await expect
      .element(screen.getByRole('button', { name: 'primeira pergunta', exact: true }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('esc para o Fluxo, preserva o texto e oferece tentar de novo', async () => {
    const { provider, delta } = gatedProvider();
    const screen = await mount(() => provider);
    await connect(screen);

    await userEvent.fill(screen.getByLabelText('mensagem'), 'Pergunta longa');
    await userEvent.keyboard('{Enter}');
    await delta;
    await expect.element(screen.getByRole('button', { name: /parar/ })).toBeVisible();

    await userEvent.keyboard('{Escape}');

    await expect.element(screen.getByText('resposta interrompida.')).toBeVisible();
    await expect.element(screen.getByText('a', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'tentar de novo' })).toBeVisible();
  });

  it('shift+enter quebra linha sem enviar', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()));
    await connect(screen);

    const input = screen.getByLabelText('mensagem');
    await userEvent.click(input);
    await userEvent.keyboard('linha 1{Shift>}{Enter}{/Shift}linha 2');

    await expect.element(input).toHaveValue('linha 1\nlinha 2');
    expect(screen.container.querySelector('article')).toBeNull();
  });

  it('copiar leva o Markdown original da resposta', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const screen = await mount(() => new ScriptedProvider(replyEvents('**Olá**, tudo certo.')));
    await connect(screen);
    await userEvent.fill(screen.getByLabelText('mensagem'), 'Pergunta');
    await userEvent.keyboard('{Enter}');

    await userEvent.click(screen.getByRole('button', { name: 'copiar' }));

    expect(writeText).toHaveBeenCalledWith('**Olá**, tudo certo.');
    await expect.element(screen.getByRole('button', { name: 'copiado' })).toBeVisible();
    writeText.mockRestore();
  });

  it('apagar uma Conversa sai do menu da linha e pede confirmação', async () => {
    const screen = await mount(() => new ScriptedProvider(replyEvents()));
    await connect(screen);
    await userEvent.fill(screen.getByLabelText('mensagem'), 'Para apagar');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByText('Olá')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'ações de para apagar' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'apagar' }));
    await userEvent.click(screen.getByRole('button', { name: 'sim, apagar' }));

    await expect.element(screen.getByText('suas conversas aparecem aqui.')).toBeVisible();
  });
});
