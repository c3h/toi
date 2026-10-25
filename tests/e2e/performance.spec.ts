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

// docs/architecture.md §9: nenhuma long task > 50 ms durante um Fluxo de 500 deltas.
test('Fluxo de 500 deltas sem long task acima de 50 ms', async ({ page }) => {
  await connect(page);

  // Aquece o chunk de Markdown e o worker do Shiki fora da medição: download não é Fluxo.
  await setMock(page, { reply: '```ts\nconst a = 1;\n```', deltas: 1, delayMs: 0 });
  await send(page, 'aquecer');
  await expect(page.locator('.code-block .token').first()).toBeVisible();

  await page.evaluate(() => {
    const entries: number[] = [];
    (window as unknown as { __long: number[] }).__long = entries;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) entries.push(entry.duration);
    }).observe({ type: 'longtask' });
  });

  await setMock(page, { reply, deltas: 500, delayMs: 4 });
  await send(page, 'medir');
  await expect(page.getByText(/tokens de entrada/).nth(1)).toBeVisible({ timeout: 30_000 });

  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  expect(Math.max(0, ...long)).toBeLessThanOrEqual(50);
});
