import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // O polyfill só serve a navegador sem `modulepreload`; nele o chunk lazy baixa igual, sem
  // a pré-carga das dependências. Fora, ele sai do JS inicial.
  build: { modulePreload: { polyfill: false } },
  // Worker de módulo: com o `iife` padrão, as gramáticas, importadas sob demanda, entrariam
  // todas no arquivo do worker. O prefixo `lang-` separa os chunks das gramáticas dos do app:
  // sem ele, a gramática `markdown-*.js` entra no `Markdown-*.js` do size-limit no macOS e no
  // Windows, onde o glob não diferencia maiúsculas.
  worker: {
    format: 'es',
    rolldownOptions: { output: { chunkFileNames: 'assets/lang-[name]-[hash].js' } },
  },
  // A varredura de dependências não segue o `new URL` do worker: sem ele aqui, o Shiki só é
  // descoberto no primeiro bloco fechado, e o dev server (e o Vitest) recarrega a página.
  optimizeDeps: { entries: ['index.html', 'src/ui/markdown/highlight.worker.ts'] },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/ui/**/*.test.tsx'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
