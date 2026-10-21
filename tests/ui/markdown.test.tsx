import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { Prose } from '../../src/ui/Prose';

describe('Prose', () => {
  it('renderiza Markdown com GFM', async () => {
    const screen = await render(
      <Prose
        text={'# Título\n\n**forte** e `código`\n\n| a | b |\n|---|---|\n| 1 | 2 |'}
        streaming={false}
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
        streaming={false}
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
        streaming={false}
      />,
    );

    const link = screen.getByRole('link', { name: 'docs' });
    await expect.element(link).toHaveAttribute('target', '_blank');
    await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.container.querySelector('img')).toBeNull();
    await expect.element(screen.getByText('[imagem: logo]')).toBeVisible();
  });

  it('descarta link javascript:', async () => {
    const screen = await render(<Prose text={'[clique](javascript:alert(1))'} streaming={false} />);
    await expect.element(screen.getByText('clique')).toBeVisible();
    expect(screen.container.querySelector('a')?.getAttribute('href') ?? '').not.toContain(
      'javascript',
    );
  });

  it('colore o código só quando o bloco fecha', async () => {
    const code = '```ts\nconst a = 1;\n```';
    const screen = await render(<Prose text={`${code}\n\nainda chegando`} streaming />);

    await expect.element(screen.getByText('ainda chegando')).toBeVisible();
    // O bloco de código já fechou: o último bloco é o parágrafo.
    await expect
      .poll(() => screen.container.querySelectorAll('.code-block .token').length)
      .toBeGreaterThan(0);

    const open = await render(<Prose text={'```ts\nconst b = 2;'} streaming />);
    await expect.element(open.getByText('const b = 2;')).toBeVisible();
    expect(open.container.querySelectorAll('.token')).toHaveLength(0);
  });
});
