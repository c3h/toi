# Publicação

O Toi é publicado em **https://toi.gimigliano.blog** pelo Cloudflare Workers
Static Assets. O deploy contém apenas o build estático; a decisão está no
[ADR 0001](adr/0001-static-local-first-spa.md).

## CI/CD

O repositório público é [c3h/toi](https://github.com/c3h/toi), sob a
[licença MIT](../LICENSE).

O [workflow CI](../.github/workflows/ci.yml) executa o gate `npm run check` e
valida o pacote de publicação com `wrangler deploy --dry-run` em pull requests
e pushes para `main`. A versão de Node vem de [.node-version](../.node-version)
e as dependências são instaladas pelo lockfile com `npm ci`.

A branch `main` exige o check `check` antes do merge. O Cloudflare Workers
Builds acompanha essa branch, gera os arquivos com `npm run build` e publica
com `npm run deploy`. Pull requests não recebem credenciais de deploy.

A configuração do destino e do domínio está em
[wrangler.jsonc](../wrangler.jsonc). O host aplica os headers de
[public/_headers](../public/_headers); a política de segurança está na
[arquitetura, seção 8](architecture.md#8-segurança).

Nenhuma Chave da Anthropic é configurada no GitHub ou no Cloudflare. Cada
pessoa informa a sua na aplicação. Analytics, beacon e injeção de scripts do
host ficam desativados.

## Publicar uma instância própria

1. Faça um fork e siga [CONTRIBUTING.md](../CONTRIBUTING.md) para preparar o ambiente.
2. Mude `name` e `routes` em `wrangler.jsonc` para seu Worker e seu domínio.
3. No Cloudflare, conecte o repositório ao Workers Builds, com os comandos de
   build e deploy descritos acima, e proteja a branch de produção com o CI.
4. Confira o HTTPS e o header `Content-Security-Policy` na URL publicada.

O domínio precisa estar na conta Cloudflare que publica o Worker. Para publicar
do terminal, autentique o Wrangler nessa conta e execute `npm run build` seguido
de `npm run deploy`.

## Falha e reversão

Um CI que falha impede o merge; um build ou deploy que falha mantém a versão
publicada. Para voltar uma mudança, reverta o commit por pull request e deixe
o pipeline publicar novamente. Para uma reversão imediata, use o rollback de
uma versão anterior na aba Deployments do Worker e depois reverta o código.

O armazenamento Local pertence à origem do navegador: mudar de domínio não
transfere o histórico nem a Chave. O domínio acima é a URL estável de uso.
