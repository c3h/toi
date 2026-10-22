import { connect, expect, test } from './fixtures';

// Uma aba aberta antes de um deploy pede chunks que o deploy apagou.

test('configurações que não baixam pedem recarregar, e recarregar resolve', async ({ page }) => {
  await connect(page);
  await page.route('**/assets/Settings-*.js', (route) => route.fulfill({ status: 404 }));

  await page.getByRole('button', { name: /configurações/ }).click();
  await expect(page.getByText(/as configurações não carregaram/)).toBeVisible();
  await page.getByRole('button', { name: 'voltar' }).click();
  await expect(page.getByLabel('mensagem')).toBeVisible();

  await page.getByRole('button', { name: /configurações/ }).click();
  await page.unroute('**/assets/Settings-*.js');
  await page.getByRole('button', { name: 'recarregar' }).click();
  await page.getByRole('button', { name: /configurações/ }).click();
  await expect(page.getByRole('heading', { name: 'configurações' })).toBeVisible();
});

test('anexo cujo preparo não baixa pede recarregar a página', async ({ page }) => {
  await connect(page);
  await page.route('**/assets/prepare-*.js', (route) => route.fulfill({ status: 404 }));

  await page.locator('input[type="file"]').setInputFiles({
    name: 'nota.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('oi'),
  });
  await expect(page.getByText('recarregue a página para anexar')).toBeVisible();
});
