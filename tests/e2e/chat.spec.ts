/// <reference types="node" />
import { connect, expect, send, setMock, test } from './fixtures';

test('envia e vê a resposta em Markdown', async ({ page }) => {
  await connect(page);
  await setMock(page, { reply: 'Resposta com **ênfase** e `código`.', deltas: 8 });

  await send(page, 'Primeira pergunta');

  await expect(page.locator('strong', { hasText: 'ênfase' })).toBeVisible();
  await expect(page.getByText(/12 tokens de entrada/)).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('primeira pergunta');
});

test('parar mantém o texto recebido e tentar de novo substitui a resposta', async ({ page }) => {
  await connect(page);
  await setMock(page, { reply: 'palavra '.repeat(200), deltas: 200, delayMs: 30 });

  await send(page, 'Pergunta longa');
  await expect(page.getByText(/palavra palavra/)).toBeVisible();
  await page.getByRole('button', { name: /parar/ }).click();

  await expect(page.getByText('resposta interrompida.')).toBeVisible();

  await setMock(page, { reply: 'Agora completa.', deltas: 2, delayMs: 0 });
  await page.getByRole('button', { name: 'tentar de novo' }).click();

  await expect(page.getByText('Agora completa.')).toBeVisible();
  await expect(page.getByText('resposta interrompida.')).toHaveCount(0);
  await expect(page.locator('article')).toHaveCount(2);
});

test('recarregar no meio do Fluxo deixa a Mensagem interrompida, não presa', async ({ page }) => {
  await connect(page);
  await setMock(page, { reply: 'trecho '.repeat(300), deltas: 300, delayMs: 30 });

  await send(page, 'Vou recarregar');
  // Até 300 ms de Fluxo vivem só em memória (§4); com 20 deltas de 30 ms, um flush já passou.
  await page.waitForFunction(
    () =>
      (document.querySelector('[aria-busy="true"]')?.textContent?.match(/trecho/g)?.length ?? 0) >=
      20,
  );

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
  await setMock(page, { reply: 'compartilhado '.repeat(120), deltas: 120, delayMs: 40 });
  await send(page, 'Conversa disputada');
  await expect(page.getByText(/compartilhado compartilhado/)).toBeVisible();

  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'conversa disputada', exact: true }).click();

  // O que a primeira aba grava aparece na segunda, sem recarregar.
  await expect(other.getByText(/compartilhado compartilhado/)).toBeVisible();

  await send(other, 'Tentando ao mesmo tempo');
  await expect(other.getByRole('status')).toContainText('espere a operação atual terminar');
  await expect(other.getByLabel('mensagem')).toHaveValue('Tentando ao mesmo tempo');

  await expect(page.getByText(/tokens de entrada/)).toBeVisible({ timeout: 15_000 });
  await expect(other.getByText(/tokens de entrada/)).toBeVisible();
});

test('exportação baixa o histórico sem a Chave', async ({ page }) => {
  await connect(page);
  await send(page, 'Para exportar');
  await expect(page.getByText('Olá.')).toBeVisible();

  await page.keyboard.press('c');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'exportar histórico' }).click();

  const file = await (await download).path();
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(file, 'utf8');
  expect(JSON.parse(content).format).toBe('toi.history');
  expect(content).toContain('Para exportar');
  expect(content).not.toContain('sk-ant-teste');
});

test('ir para o fim aparece só fora do fim e leva de volta', async ({ page }) => {
  await connect(page);
  const reply = Array.from({ length: 60 }, (_, index) => `Parágrafo ${index}.`).join('\n\n');
  await setMock(page, { reply, deltas: 1 });
  await send(page, 'Resposta longa');
  const last = page.getByText('Parágrafo 59.');
  await expect(last).toBeInViewport();

  const toEnd = page.getByRole('button', { name: 'ir para o fim' });
  await expect(toEnd).toBeHidden();

  await page.getByText('Parágrafo 0.').hover();
  await page.mouse.wheel(0, -10_000);
  await toEnd.click();

  await expect(last).toBeInViewport();
  await expect(toEnd).toBeHidden();
});
