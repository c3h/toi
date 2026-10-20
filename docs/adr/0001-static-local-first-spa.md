# O Toi é um SPA estático, sem backend

O produto existe para a pessoa abrir uma URL, colar a Chave e conversar sem que nada seja gravado em servidor. Um backend só teria três funções possíveis: esconder a Chave, servir arquivos ou sincronizar dados — e as duas primeiras não valem a operação. Decidimos publicar um build estático (Vite) que roda inteiro no navegador: nenhuma rota de API, nenhum banco, nenhuma conta. O deploy é um conjunto de arquivos estáticos com headers, como Cloudflare Pages.

## Considered Options

- **Next.js com API routes**: permitiria esconder a Chave e servir busca na web, mas cria um servidor que passa a ver todo o tráfego e a guardar a credencial de cada pessoa. Contradiz o produto.
- **App desktop (Tauri/Electron)**: resolveria CORS e daria acesso a arquivos, mas adiciona instalação e assinatura, e a proposta é justamente "abre o site e usa".
- **Extensão de navegador**: mesma conveniência, mas distribuição e permissões piores.

## Consequences

- Toda integração depende de CORS do Provedor (ADR-0002).
- Não há compartilhamento, sincronização nem colaboração; um recurso desses exige um servidor e vira outro produto.
- O backup é responsabilidade da pessoa, e o navegador pode despejar o armazenamento; por isso exportação é o primeiro item do roadmap (`architecture.md` §12).
- Custo de operação é o de hospedar arquivos, perto de zero.
