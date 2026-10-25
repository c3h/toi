# Conversas e Chave vivem em IndexedDB, em stores separados

Conversas, Mensagens e Configurações ficam no IndexedDB (Dexie), não no `localStorage`: o volume cresce, a escrita é assíncrona e o histórico não deve bloquear a thread principal. A Chave fica em um store próprio, `credentials`, e nenhuma rotina de leitura de Conversas o toca. Isso mantém exportação, backup e "apagar tudo" incapazes de vazar a Chave por acidente.

A Chave **não** é criptografada na v1. Criptografar com uma passphrase deriva uma chave que precisa estar na memória durante a sessão; qualquer XSS lê a mesma memória. Criptografia aqui protegeria contra acesso ao disco, não contra o threat model real, e daria uma falsa sensação de segurança.

## Consequences

- Com a UI, `navigator.storage.persist()` será pedido na primeira Conversa; se negado, a UI avisa que o navegador pode limpar os dados.
- A Chave sobrevive a "apagar conversas" e é removida só por ação explícita.
- Desde 2026-10-22, `credentials` guarda uma Chave por dono, Provedor ou Serviço ([ADR 0010](0010-web-tools-via-tinyfish.md)). O keyPath continua `provider`: trocá-lo na mesma versão do Dexie faz toda gravação falhar.
- `ConversationStore` não expõe `clearAll` e não alcança `credentials`: "apagar tudo" é composição em `toi.eraseAll` (`app/toi.ts`: `clearConversations` + `settings.clear` + `credentials.clear`). O contrato do store roda contra memória e Dexie e verifica que limpar Conversas preserva Chave e Configurações.
- A exportação em JSON lê apenas a porta de Conversas; a Chave nunca entra no arquivo ([ADR 0007](0007-explicit-persisted-formats.md)).
- Duas abas podem selecionar Conversas diferentes. Escrever Mensagens na mesma Conversa é exclusivo de uma aba por vez ([ADR 0006](0006-web-locks-cross-tab.md)); metadados da Conversa, como o Título, seguem last write wins.
