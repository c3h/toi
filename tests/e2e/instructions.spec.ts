import { connect, expect, send, test } from './fixtures';

test('as Instruções salvas sobrevivem à recarga e vão em system no envio', async ({ page }) => {
  await connect(page);
  await page.getByRole('button', { name: /configurações/ }).click();
  await page.getByLabel('instruções').fill('responda curto');
  await page.getByRole('button', { name: 'salvar' }).click();
  await expect(page.getByText('salvo.')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /configurações/ }).click();
  await expect(page.getByLabel('instruções')).toHaveValue('responda curto');
  await page.getByRole('button', { name: /voltar/ }).click();

  await send(page, 'Pergunta');

  await expect(page.getByText('Olá.')).toBeVisible();
  // O pedido da resposta entre os que saíram: o do Título, quando há, leva outro texto.
  await expect
    .poll(() => page.evaluate(() => window.__bodies.map((body): unknown => JSON.parse(body))))
    .toContainEqual(
      expect.objectContaining({
        system: 'responda curto',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Pergunta' }] }],
      }),
    );
});
