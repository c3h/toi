import { connect, expect, send, setMock, test } from './fixtures';

test('envia e vê a resposta em Markdown', async ({ page }) => {
  await connect(page);
  // Com atraso entre deltas o Fluxo tem duração, e a vazão aparece.
  await setMock(page, { reply: 'Resposta com **ênfase** e `código`.', deltas: 8, delayMs: 20 });

  await send(page, 'Primeira pergunta');
  // O pedido da Mensagem entre os que saíram: o do Título, quando há, leva outro texto.
  await expect
    .poll(() => page.evaluate(() => window.__bodies.map((body): unknown => JSON.parse(body))))
    .toContainEqual(
      expect.objectContaining({
        cache_control: { type: 'ephemeral' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Primeira pergunta' }] }],
      }),
    );

  await expect(page.locator('strong', { hasText: 'ênfase' })).toBeVisible();
  await expect(page.getByTitle('12 tokens de entrada, 8 de saída')).toBeVisible();
  await expect(page.getByTitle(/até o modelo responder$/)).toBeVisible();
  await expect(page.getByTitle(/tokens por segundo$/)).toBeVisible();
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

test('ir para o fim aparece só fora do fim e leva de volta', async ({ page }) => {
  await connect(page);
  // Respostas mais altas que a reserva de `content-visibility`, e tantas que o meio não
  // aparece ao abrir.
  for (let reply = 0; reply < 12; reply += 1) {
    const paragraphs = Array.from(
      { length: 20 },
      (_, index) => `Resposta ${reply}, parágrafo ${index}.`,
    );
    await setMock(page, { reply: paragraphs.join('\n\n'), deltas: 1 });
    await send(page, `Pergunta ${reply}`);
    await expect(page.getByText(paragraphs.at(-1)!, { exact: true })).toBeInViewport();
  }
  // Recarregada, a Conversa abre no fim e as Mensagens do meio reservam a altura média, não a
  // real.
  await page.reload();
  const last = page.getByText('Resposta 11, parágrafo 19.', { exact: true });
  await expect(last).toBeInViewport();

  const toEnd = page.getByRole('button', { name: 'ir para o fim' });
  await expect(toEnd).toBeHidden();

  // Direto ao topo: o caminho de volta mostra o meio pela primeira vez, e o fim anda.
  await page.getByText('Resposta 0, parágrafo 0.', { exact: true }).hover();
  await toEnd.click();

  await expect(last).toBeInViewport();
  await expect(toEnd).toBeHidden();
});
