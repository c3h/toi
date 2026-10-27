import { connect, expect, hold, send, test } from './fixtures';

test('envia e vê a resposta em Markdown', async ({ page }) => {
  await connect(page);
  const answer = await hold(page);

  await send(page, 'Primeira pergunta');
  // A resposta aberta entre um delta e outro dá duração ao Fluxo, e a vazão aparece.
  await answer.write('Resposta com **ênfase**');
  await expect(page.locator('strong', { hasText: 'ênfase' })).toBeVisible();
  await answer.write(' e `código`.');
  await answer.end();
  expect(JSON.parse(await answer.body())).toEqual(
    expect.objectContaining({
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Primeira pergunta' }] }],
    }),
  );

  await expect(page.locator('code', { hasText: 'código' })).toBeVisible();
  await expect(page.getByTitle('12 tokens de entrada, 2 de saída')).toBeVisible();
  await expect(page.getByTitle(/até o modelo responder$/)).toBeVisible();
  await expect(page.getByTitle(/tokens por segundo$/)).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('primeira pergunta');
});

test('parar mantém o texto recebido e tentar de novo substitui a resposta', async ({ page }) => {
  await connect(page);
  const answer = await hold(page);

  await send(page, 'Pergunta longa');
  await answer.write('palavra '.repeat(20));
  await expect(page.getByText(/palavra palavra/)).toBeVisible();
  await page.getByRole('button', { name: /parar/ }).click();

  await expect(page.getByText('resposta interrompida.')).toBeVisible();

  const retry = await hold(page);
  await page.getByRole('button', { name: 'tentar de novo' }).click();
  await retry.write('Agora completa.');
  await retry.end();

  await expect(page.getByText('Agora completa.')).toBeVisible();
  await expect(page.getByText('resposta interrompida.')).toHaveCount(0);
  await expect(page.locator('article')).toHaveCount(2);
});

test('recarregar no meio do Fluxo deixa a Mensagem interrompida, não presa', async ({
  context,
  page,
}) => {
  await connect(page);
  const answer = await hold(page);

  await send(page, 'Vou recarregar');
  await answer.write('trecho '.repeat(20));
  // Até 300 ms de Fluxo vivem só em memória (§4): outra aba só mostra o trecho depois de gravado.
  const witness = await context.newPage();
  await witness.goto('/');
  await witness.getByRole('button', { name: 'vou recarregar', exact: true }).click();
  await expect(witness.getByText(/trecho trecho/)).toBeVisible();
  await witness.close();

  await page.reload();

  await expect(page.getByText('resposta interrompida.')).toBeVisible();
  await expect(page.getByText(/trecho trecho/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'tentar de novo' })).toBeVisible();
});

test('duas abas: a segunda vê o Fluxo da primeira e não escreve ao mesmo tempo', async ({
  context,
  page,
}) => {
  await connect(page);
  const answer = await hold(page);
  await send(page, 'Conversa disputada');
  await answer.write('compartilhado '.repeat(20));
  await expect(page.getByText(/compartilhado compartilhado/)).toBeVisible();

  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'conversa disputada', exact: true }).click();

  // O que a primeira aba grava aparece na segunda, sem recarregar.
  await expect(other.getByText(/compartilhado compartilhado/)).toBeVisible();

  await send(other, 'Tentando ao mesmo tempo');
  await expect(other.getByRole('status')).toContainText('espere a operação atual terminar');
  await expect(other.getByLabel('mensagem')).toHaveValue('Tentando ao mesmo tempo');

  await answer.end();
  await expect(page.getByText(/tokens de entrada/)).toBeVisible();
  await expect(other.getByText(/tokens de entrada/)).toBeVisible();
});
