import { connect, expect, send, setMock, test } from './fixtures';

/** PNG de 1×1, vermelho. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const CONTRACT = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >> endobj\n%%EOF\n');

test('anexos sobrevivem à recarga e tentar de novo reenvia os bytes', async ({ page }) => {
  await connect(page);

  await page.locator('input[type="file"]').setInputFiles([
    { name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL },
    { name: 'contrato.pdf', mimeType: 'application/pdf', buffer: CONTRACT },
  ]);
  await expect(page.getByText(/2 pág · /)).toBeVisible();
  await setMock(page, { reply: 'palavra '.repeat(200), deltas: 200, delayMs: 30 });
  await send(page, 'Leia os dois');
  await expect(page.getByText(/palavra palavra/)).toBeVisible();
  await page.getByRole('button', { name: /parar/ }).click();

  const first = await page.evaluate(() => window.__lastBody);
  expect(first).toContain('"type":"image"');
  expect(first).toContain(CONTRACT.toString('base64'));

  await page.reload();
  await expect(page.getByRole('button', { name: 'baixar contrato.pdf' })).toBeVisible();
  await page.getByRole('button', { name: 'ver pixel.png' }).click();
  await expect(page.getByRole('dialog', { name: 'pixel.png' }).locator('img')).toBeVisible();
  await page.keyboard.press('Escape');

  await setMock(page, { reply: 'Agora completa.', deltas: 1, delayMs: 0 });
  await page.getByRole('button', { name: 'tentar de novo' }).click();
  await expect(page.getByText('Agora completa.')).toBeVisible();
  expect(await page.evaluate(() => window.__lastBody)).toContain(CONTRACT.toString('base64'));
});
