# Contribuir

Issues e pull requests são bem-vindos em [c3h/toi](https://github.com/c3h/toi).
Para mudanças de escopo ou de arquitetura, abra uma issue antes de implementar.
As regras de trabalho estão em [AGENTS.md](AGENTS.md); o vocabulário está em
[CONTEXT.md](CONTEXT.md), e o desenho em [docs/architecture.md](docs/architecture.md).

## Preparar e verificar

Use a versão de Node de [.node-version](.node-version).

```sh
npm ci
npx playwright install chromium
npm run dev
```

Antes de abrir um pull request, rode `npm run check`. Em Linux, instale também
as dependências de sistema do Chromium com `npx playwright install --with-deps chromium`.
Os testes simulam o Provedor; nenhuma Chave real é necessária.

Descreva o problema, a mudança de comportamento e como verificou o resultado.
Mantenha a documentação da decisão junto do código, conforme as regras do projeto.

## Licença

As contribuições são distribuídas sob a [licença MIT](LICENSE) do projeto.
Para relatar uma vulnerabilidade, consulte [SECURITY.md](SECURITY.md).
