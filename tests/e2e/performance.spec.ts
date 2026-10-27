import type { Page } from '@playwright/test';
import { connect, expect, hold, send, test, type HeldReply } from './fixtures';

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
  const answer = await hold(page);
  await send(page, 'aquecer');
  await answer.write('```ts\nconst a = 1;\n```');
  await answer.end();
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

/** 500 deltas a cada 4 ms, no ritmo de um Provedor: a carga que o orçamento mede. */
const stream = async (answer: HeldReply) => {
  await answer.pace(reply, 500, 4);
  await answer.end();
};

const longestTask = async (page: Page): Promise<number> => {
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  return Math.max(0, ...long);
};

// docs/architecture.md §9: nenhuma long task > 50 ms durante um Fluxo de 500 deltas. Com dois em
// paralelo, um à vista e outro em segundo plano, a carga contém a de um só.
test('dois Fluxos de 500 deltas em paralelo sem long task acima de 50 ms', async ({ page }) => {
  await connect(page);
  await warmUp(page);
  await observeLongTasks(page);

  const newConversation = page.getByRole('button', { name: '[n] nova conversa', exact: true });
  const responding = page.getByRole('navigation', { name: 'conversas' }).getByLabel('respondendo');
  const background = await hold(page);
  await newConversation.click();
  await send(page, 'em segundo plano');
  await expect(responding).toHaveCount(1);
  const visible = await hold(page);
  await newConversation.click();
  await send(page, 'à vista');
  await expect(responding).toHaveCount(2);

  await Promise.all([stream(background), stream(visible)]);
  await expect(page.getByText(/tokens de entrada/)).toBeVisible();
  await expect(responding).toHaveCount(0);

  expect(await longestTask(page)).toBeLessThanOrEqual(50);

  // A de segundo plano também terminou inteira, não só parou.
  await page.getByRole('navigation', { name: 'conversas' }).getByTitle('em segundo plano').click();
  await expect(page.getByText(/tokens de entrada/)).toBeVisible();
});
