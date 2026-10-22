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

A branch `main` exige o check `check` antes do merge. Em pushes para ela, ou
execuções manuais do workflow nessa branch, o CI guarda `dist` como artefato
`site`. O job `deploy` só começa depois do gate e publica esse mesmo artefato
com `npm run deploy`. Não há conferência HTTP depois do upload: o Bot Fight
Mode da zona desafia os runners do GitHub, e o Toi é de uso pessoal. Confira a
URL no navegador quando a mudança mexer em headers. Uma nova execução de
produção espera a anterior terminar; atualizar um pull request cancela seu CI
anterior.

O ambiente GitHub `production` aceita somente branches protegidas; `main` é
a única branch protegida. Ele guarda o segredo `CLOUDFLARE_API_TOKEN` e a
variável `CLOUDFLARE_ACCOUNT_ID`. O token tem `Workers Scripts: Edit` na conta,
`Workers Routes: Edit` e `Zone: Read` apenas na zona do domínio. Não tem
permissões de R2, KV ou bancos. A permissão de Workers é por conta e também
alcança os outros Workers dela. Pull requests não executam o job de deploy.

A configuração do destino e do domínio está em
[wrangler.jsonc](../wrangler.jsonc). O host aplica os headers de
[public/_headers](../public/_headers); a política de segurança está na
[arquitetura, seção 8](architecture.md#8-segurança).

Nenhuma Chave da Anthropic é configurada no GitHub ou no Cloudflare. Cada
pessoa informa a sua na aplicação. Analytics, beacon e injeção de scripts do
host ficam desativados.

O HTML usa `Cache-Control: no-transform` em `public/_headers` para impedir
injeção de JavaScript Detections pelo host. A diretiva só se aplica ao HTML:
os assets continuam recebendo a compressão do Cloudflare. O Network Error
Logging (NEL) da zona também precisa ficar desativado, pois instrui o navegador
a enviar relatórios de rede ao Cloudflare.

## Publicar uma instância própria

1. Faça um fork e siga [CONTRIBUTING.md](../CONTRIBUTING.md) para preparar o ambiente.
2. Mude `name` e `routes` em `wrangler.jsonc` para seu Worker e seu domínio.
3. Proteja a branch de produção com o CI. No GitHub, crie o ambiente `production`,
   limitado a essa branch, e configure a variável e o segredo descritos acima
   com sua conta e um token restrito à publicação. Ajuste também a URL do ambiente
   no workflow para seu domínio.
4. Desative NEL na zona Cloudflare e confira HTTPS, HTML e headers na URL publicada.

O domínio precisa estar na conta Cloudflare que publica o Worker. Para publicar
do terminal, autentique o Wrangler nessa conta e execute `npm run build` seguido
de `npm run deploy`.

## Falha e reversão

Um CI que falha impede o merge; uma falha no gate impede o job de deploy.
Falha na publicação aparece no Actions: confira a URL e a versão no Cloudflare
antes de decidir a reversão. Para voltar uma mudança,
reverta o commit por pull request e deixe o pipeline publicar novamente.
Para uma reversão imediata, use o rollback de
uma versão anterior na aba Deployments do Worker e depois reverta o código.

O armazenamento Local pertence à origem do navegador: mudar de domínio não
transfere o histórico nem a Chave. O domínio acima é a URL estável de uso.
