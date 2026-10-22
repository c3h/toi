# Toi

Chat local-first com modelos da Anthropic. Abra, cole sua Chave, converse. O histórico fica no navegador e a única saída de dados é a Conversa enviada à Anthropic para gerar a resposta.

[Abrir o Toi](https://toi.gimigliano.blog) · [Contribuir](CONTRIBUTING.md) · [MIT](LICENSE)

## Estado

A v1 está completa. Escopo e desenho em `docs/architecture.md`.

`npm run check` é o gate completo (o que ele roda está em `docs/architecture.md` §11); na primeira vez, `npx playwright install chromium`. O orçamento de performance está em `docs/architecture.md` §9.

## Rodar

```sh
npm ci
npm run dev
```

## Aviso

O histórico vive no armazenamento do navegador. Limpar os dados do site apaga tudo. O Safari pode descartar esse armazenamento sem uso prolongado; os detalhes e a exportação estão em `docs/architecture.md` §6.

## Docs

- `CONTEXT.md` — vocabulário do domínio.
- `docs/architecture.md` — escopo, desenho, erros, segurança e performance.
- `docs/adr/` — decisões e porquês.
- [Publicação](docs/deployment.md) — domínio, CI/CD e deploy próprio.
- [Contribuir](CONTRIBUTING.md) e [relatar vulnerabilidades](SECURITY.md).
