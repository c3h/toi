import { connect, expect, send, setMock, test } from './fixtures';

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

test('código cujo destaque não baixa fica sem cor até recarregar', async ({ page }) => {
  await connect(page);
  const worker = '**/assets/highlight.worker-*.js';
  let requests = 0;
  await page.route(worker, (route) => {
    requests += 1;
    return route.fulfill({ status: 404 });
  });

  const plain = async (nth: number, code: string) => {
    await expect(page.getByText(/tokens de entrada/).nth(nth)).toBeVisible();
    const block = page.locator('.code-block pre').nth(nth);
    await expect(block).toHaveAttribute('aria-busy', 'false');
    await expect(block).toHaveText(code);
    await expect(block.locator('.token')).toHaveCount(0);
  };

  await setMock(page, { reply: '```ts\nconst a = 1;\n```', deltas: 1, delayMs: 0 });
  await send(page, 'primeiro');
  await plain(0, 'const a = 1;');

  // O worker que caiu não é pedido de novo a cada bloco.
  await setMock(page, { reply: '```ts\nconst b = 2;\n```', deltas: 1, delayMs: 0 });
  await send(page, 'segundo');
  await plain(1, 'const b = 2;');
  expect(requests).toBe(1);

  await page.unroute(worker);
  await page.reload();
  await expect(page.locator('.code-block .token').first()).toBeVisible();
});

test('a gramática que não baixa deixa sem cor só a linguagem dela', async ({ page }) => {
  await connect(page);
  await page.route('**/assets/lang-python-*.js', (route) => route.fulfill({ status: 404 }));

  await setMock(page, {
    reply: '```python\nx = 1\n```\n\n```ts\nconst a = 1;\n```',
    deltas: 1,
    delayMs: 0,
  });
  await send(page, 'código');
  await expect(page.getByText(/tokens de entrada/)).toBeVisible();

  const python = page.locator('.code-block pre').first();
  await expect(python).toHaveAttribute('aria-busy', 'false');
  await expect(python.locator('.token')).toHaveCount(0);
  await expect(page.locator('.code-block pre').nth(1).locator('.token').first()).toBeVisible();
});
