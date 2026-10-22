import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { Prose } from '../../src/ui/Prose';

describe('Prose', () => {
  it('renderiza Markdown com GFM', async () => {
    const screen = await render(
      <Prose
        text={'# Título\n\n**forte** e `código`\n\n| a | b |\n|---|---|\n| 1 | 2 |'}
        open={false}
      />,
    );

    await expect.element(screen.getByRole('heading', { name: 'Título' })).toBeVisible();
    await expect.element(screen.getByText('forte')).toBeVisible();
    await expect.element(screen.getByRole('table')).toBeVisible();
  });

  it('não transforma HTML da resposta em DOM', async () => {
    const screen = await render(
      <Prose
        text={'antes <img src="x" onerror="window.__xss = 1"> <b>cru</b> depois'}
        open={false}
      />,
    );

    await expect.element(screen.getByText(/antes/)).toBeVisible();
    expect(screen.container.querySelector('img')).toBeNull();
    expect(screen.container.querySelector('b')).toBeNull();
    expect((window as { __xss?: number }).__xss).toBeUndefined();
  });

  it('abre links fora da aba sem referrer e não carrega imagens', async () => {
    const screen = await render(
      <Prose
        text={'[docs](https://example.com) ![logo](https://example.com/logo.png)'}
        open={false}
      />,
    );

    const link = screen.getByRole('link', { name: 'docs' });
    await expect.element(link).toHaveAttribute('target', '_blank');
    await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.container.querySelector('img')).toBeNull();
    await expect.element(screen.getByText('[imagem: logo]')).toBeVisible();
  });

  it('descarta link javascript:', async () => {
    const screen = await render(<Prose text={'[clique](javascript:alert(1))'} open={false} />);
    await expect.element(screen.getByText('clique')).toBeVisible();
    expect(screen.container.querySelector('a')?.getAttribute('href') ?? '').not.toContain(
      'javascript',
    );
  });

  it('colore o código só quando o bloco fecha', async () => {
    const code = '```ts\nconst a = 1;\n```';
    const screen = await render(<Prose text={`${code}\n\nainda chegando`} open />);

    await expect.element(screen.getByText('ainda chegando')).toBeVisible();
    // O bloco de código já fechou: o último bloco é o parágrafo.
    await expect
      .poll(() => screen.container.querySelectorAll('.code-block .token').length)
      .toBeGreaterThan(0);

    const open = await render(<Prose text={'```ts\nconst b = 2;'} open />);
    await expect.element(open.getByText('const b = 2;')).toBeVisible();
    expect(open.container.querySelectorAll('.token')).toHaveLength(0);
  });

  it('fecha o Markdown do bloco em Fluxo como ele vai ficar', async () => {
    const bold = await render(<Prose text={'texto **neg'} open />);
    await expect.poll(() => bold.container.querySelector('strong')?.textContent).toBe('neg');
    expect(bold.container.textContent).not.toContain('**');

    const link = await render(<Prose text={'veja [o link](https://exa'} open />);
    await expect.poll(() => link.container.textContent).toContain('veja o link');
    expect(link.container.textContent).not.toContain('https');
    expect(link.container.querySelector('a')).toBeNull();
  });

  it('anima palavra por palavra só quando pedido', async () => {
    const live = await render(<Prose text={'um `dois` três'} open animate />);
    await expect.element(live.getByText('três')).toBeVisible();
    expect([...live.container.querySelectorAll('.word')].map((word) => word.textContent)).toEqual([
      'um',
      'dois',
      'três',
    ]);

    const stored = await render(<Prose text={'um `dois` três'} open={false} />);
    await expect.poll(() => stored.container.textContent).toContain('três');
    expect(stored.container.querySelectorAll('.word')).toHaveLength(0);
  });

  it('põe o cursor só quando pedido, mesmo em Fluxo', async () => {
    const flowing = await render(<Prose text={'um dois'} open />);
    await expect.element(flowing.getByText('dois')).toBeVisible();
    expect(flowing.container.querySelector('.caret')).toBeNull();

    const waiting = await render(<Prose text={'um três'} open caret />);
    await expect.element(waiting.getByText('três')).toBeVisible();
    expect(waiting.container.querySelector('.caret')).not.toBeNull();
  });

  it('mantém as palavras à vista quando o texto cresce e quando fecha', async () => {
    const screen = await render(<Prose text={'um do'} open animate />);
    await expect.element(screen.getByText('do')).toBeVisible();
    const [first, last] = screen.container.querySelectorAll('.word');

    await screen.rerender(<Prose text={'um dois três'} open animate />);
    await expect.element(screen.getByText('três')).toBeVisible();
    const grown = screen.container.querySelectorAll('.word');
    expect(grown[0]).toBe(first);
    expect(grown[1]).toBe(last);
    expect(last?.textContent).toBe('dois');

    // Fechada a resposta, os `span` ficam: tirá-los cortaria a entrada da última palavra.
    await screen.rerender(<Prose text={'um dois três'} open={false} animate />);
    expect(screen.container.querySelectorAll('.word')[0]).toBe(first);
  });
});
