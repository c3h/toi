import type { Page } from '@playwright/test';
import { connect, expect, send, setMock, test } from './fixtures';

// Snapshots do trace executam trabalho na página e contaminam o orçamento de main thread.
test.use({ trace: 'off' });

const paragraph =
  'Um parágrafo de resposta com **ênfase**, `código` e uma [ligação](https://example.com) para ter Markdown de verdade.';

const reply = [
  ...Array.from({ length: 12 }, () => paragraph),
  '```ts\nexport const soma = (a: number, b: number): number => a + b;\nconsole.log(soma(1, 2));\n```',
  ...Array.from(
    { length: 12 },
    (_, index) => `- item ${index} com texto suficiente para quebrar linha`,
  ),
].join('\n\n');

/** Aquece o chunk de Markdown e o worker do Shiki fora da medição: download não é Fluxo. */
const warmUp = async (page: Page) => {
  await setMock(page, { reply: '```ts\nconst a = 1;\n```', deltas: 1, delayMs: 0 });
  await send(page, 'aquecer');
  await expect(page.locator('.code-block .token').first()).toBeVisible();
};

const observeLongTasks = (page: Page) =>
  page.evaluate(() => {
    const entries: number[] = [];
    (window as unknown as { __long: number[] }).__long = entries;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) entries.push(entry.duration);
    }).observe({ type: 'longtask' });
  });

const longestTask = async (page: Page): Promise<number> => {
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  return Math.max(0, ...long);
};

// docs/architecture.md §9: nenhuma long task > 50 ms durante um Fluxo de 500 deltas.
test('Fluxo de 500 deltas sem long task acima de 50 ms', async ({ page }) => {
  await connect(page);
  await warmUp(page);
  await observeLongTasks(page);

  await setMock(page, { reply, deltas: 500, delayMs: 4 });
  await send(page, 'medir');
  await expect(page.getByText(/tokens de entrada/).nth(1)).toBeVisible({ timeout: 30_000 });

  expect(await longestTask(page)).toBeLessThanOrEqual(50);
});

// Uma Conversa responde à vista enquanto outra responde em segundo plano, no mesmo orçamento.
test('dois Fluxos de 500 deltas em paralelo sem long task acima de 50 ms', async ({ page }) => {
  await connect(page);
  await warmUp(page);
  await observeLongTasks(page);

  await setMock(page, { reply, deltas: 500, delayMs: 4 });
  const newConversation = page.getByRole('button', { name: '[n] nova conversa', exact: true });
  const responding = page.getByRole('navigation', { name: 'conversas' }).getByLabel('respondendo');
  await newConversation.click();
  await send(page, 'em segundo plano');
  await expect(responding).toHaveCount(1);
  await newConversation.click();
  await send(page, 'à vista');
  await expect(responding).toHaveCount(2);

  await expect(page.getByText(/tokens de entrada/)).toBeVisible({ timeout: 30_000 });
  await expect(responding).toHaveCount(0, { timeout: 30_000 });

  expect(await longestTask(page)).toBeLessThanOrEqual(50);

  // A de segundo plano também terminou inteira, não só parou.
  await page.getByRole('navigation', { name: 'conversas' }).getByTitle('em segundo plano').click();
  await expect(page.getByText(/tokens de entrada/)).toBeVisible();
});
