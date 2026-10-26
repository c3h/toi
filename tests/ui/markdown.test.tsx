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

  it('colore as linguagens da lista pelos nomes do fence; fora dela, o código fica sem cor', async () => {
    const tokens = async (lang: string, code: string) => {
      const screen = await render(<Prose text={`\`\`\`${lang}\n${code}\n\`\`\``} open={false} />);
      // `aria-busy` cai quando o worker responde, com ou sem destaque. A primeira resposta de
      // cada gramática compila as regex dela no engine em JavaScript: a do C++ passa do 1 s
      // padrão do poll num runner do CI.
      await expect
        .poll(() => screen.container.querySelector('pre')?.getAttribute('aria-busy'), {
          timeout: 5000,
        })
        .toBe('false');
      expect(screen.container.querySelector('code')?.textContent).toBe(code);
      return screen.container.querySelectorAll('.token').length;
    };

    expect(await tokens('py', 'def f(): return 1')).toBeGreaterThan(0);
    expect(await tokens('zsh', 'echo "$HOME"')).toBeGreaterThan(0);
    expect(await tokens('c++', 'int main() { return 0; }')).toBeGreaterThan(0);
    expect(await tokens('Dockerfile', 'FROM node:22')).toBeGreaterThan(0);
    // O Shiki tem COBOL, a lista não.
    expect(await tokens('cobol', 'DISPLAY "OI".')).toBe(0);
  });

  it('bloco que muda de código não mostra os tokens do anterior', async () => {
    const screen = await render(<Prose text={'```ts\nconst a = 1;\n```'} open={false} />);
    await expect.poll(() => screen.container.querySelectorAll('.token').length).toBeGreaterThan(0);

    // Tentar de novo reaproveita o bloco na mesma posição com outro código.
    await screen.rerender(<Prose text={'```ts\nconst b = 2;\n```'} open={false} />);
    expect(screen.container.querySelector('code')?.textContent).toBe('const b = 2;');
    await expect.poll(() => screen.container.querySelectorAll('.token').length).toBeGreaterThan(0);
    expect(screen.container.querySelector('code')?.textContent).toBe('const b = 2;');
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
