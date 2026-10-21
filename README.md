# Toi

Chat local-first com modelos da Anthropic. Abra, cole sua Chave, converse. O histórico fica no navegador e a única saída de dados é a Conversa enviada à Anthropic para gerar a resposta.

## Estado

O núcleo está implementado: domínio, adaptador da Anthropic, persistência em IndexedDB e orquestração do Fluxo. A UI ainda é um placeholder — onboarding, histórico, composer e Markdown entram na próxima etapa. Escopo e módulos em `docs/architecture.md` (§1 e §3).

`npm run check` roda typecheck, testes, build e gate de tamanho. O orçamento de performance está em `docs/architecture.md` §9.

## Rodar

```sh
npm install
npm run dev
```

## Aviso

O histórico vive no armazenamento do navegador. Limpar os dados do site apaga tudo. O Safari pode descartar esse armazenamento sem uso prolongado; os detalhes e a exportação estão em `docs/architecture.md` §6.

## Docs

- `CONTEXT.md` — vocabulário do domínio.
- `docs/architecture.md` — escopo, desenho, erros, segurança e performance.
- `docs/adr/` — decisões e porquês.
