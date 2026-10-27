import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { Prose } from '../../src/ui/Prose';

describe('Prose', () => {
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
});
