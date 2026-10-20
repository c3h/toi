# Conversas e Chave vivem em IndexedDB, em stores separados

Conversas, Mensagens e Configurações ficam no IndexedDB (Dexie), não no `localStorage`: o volume cresce, a escrita é assíncrona e o histórico não deve bloquear a thread principal. A Chave fica em um store próprio, `credentials`, e nenhuma rotina de leitura de Conversas o toca. Isso mantém exportação, backup e "apagar tudo" incapazes de vazar a Chave por acidente.

A Chave **não** é criptografada na v1. Criptografar com uma passphrase deriva uma chave que precisa estar na memória durante a sessão; qualquer XSS lê a mesma memória. Criptografia aqui protegeria contra acesso ao disco, não contra o threat model real, e daria uma falsa sensação de segurança.

## Consequences

- Com a UI, `navigator.storage.persist()` será pedido na primeira Conversa; se negado, a UI avisa que o navegador pode limpar os dados.
- A Chave sobrevive a "apagar conversas" e é removida só por ação explícita.
- Exportação em JSON lê apenas Conversas e Configurações; a Chave nunca entra no arquivo.
- Duas abas podem selecionar Conversas diferentes. Escrever na mesma Conversa é last write wins; o lease de Fluxo (`architecture.md` §4) impede que a abertura de outra aba marque como interrompido um Fluxo vivo.
