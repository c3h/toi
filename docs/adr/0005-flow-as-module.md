# O Fluxo é um módulo da camada app

A versão anterior deixava `stop` na UI: o componente guardava o `AbortController`, chamava `abort()` e o `send-message` fechava a Mensagem. O flusher, porém, nascia dentro de `runAssistant` e não tinha interface pública — a UI não conseguia cumprir o flush de `pagehide`/`visibilitychange` prometido em `architecture.md` §4. O mesmo valia para o lease: criação no domínio, renovação no app, expiração inline na recuperação e o default de 15 s no app. Cada peça do Fluxo vivia num lugar, e a UI herdaria `AbortSignal`, `Clock`, `owner` e o ciclo de página.

Decidimos que `Flow` (`app/flow.ts`) é o módulo do Fluxo em voo. Ele é dono do `AbortController`, do `owner` e do flusher, e expõe `send`, `retry`, `stop`, `flush` e `active` (a Conversa em voo ou `null`). `stop()` aborta e espera a Mensagem fechar antes de liberar a próxima execução; `flush()` é o gancho dos eventos de página. `createToi` (`app/toi.ts`) compõe a fachada do app: lê as Chaves, cria cada Provedor registrado via `create(key)` ([ADR 0008](0008-provider-and-protocol.md)), recupera Mensagens órfãs na abertura, mantém um único `Flow` estável que lê, a cada envio, o Provedor do Modelo escolhido, expõe as use cases de histórico e compõe "apagar tudo". A UI depende só de `Toi`/`Flow`.

## Considered Options

- **UI dona do `AbortController`** (decisão anterior): menos código no app, mas a UI passa a implementar cancelamento, ciclo de página e flush; o flush nem sequer era alcançável pela interface atual.
- **Zustand dona do `AbortController`**: mesmo problema, com o estado do Fluxo duplicado entre store e app.
- **`Flow` como módulo do app** (escolhido): uma interface pequena esconde cancelamento, lease, flush e a regra de um Fluxo por vez; a UI fica com botões e eventos, não com semântica.

## Consequences

- `stop` deixa de ser detalhe de UI; `architecture.md` §3–§4 foram atualizados.
- A UI não recebe `AbortSignal`, `Clock` nem `ChatProvider`; recebe `Flow` e `Toi`.
- `disconnect`, `eraseConversations` e `eraseAll` rodam em `Flow.exclusive`: param o Fluxo e recusam `send`/`retry` com `flow_busy` até terminar, evitando que um Fluxo em voo ou iniciado durante a limpeza recrie a Mensagem. `deleteConversation` usa o mesmo mecanismo restrito à Conversa apagada, sem interromper o Fluxo de outra.
- `toi.flow` não muda de identidade ao trocar a Chave; a UI pode guardar a referência. Sem Chave, `send`/`retry` recusam com `not_connected`. Trocar a Chave não interrompe o Fluxo em voo.
- `send-message.ts` continua sendo o caso de uso; `startSendMessage`/`startRetryMessage` expõem um `MessageRun` com `flush` para o `Flow` — o teste de enviar/abortar/retry continua na mesma fronteira.
- Um `Toi` tem no máximo um Fluxo ativo; um segundo `send`/`retry` é recusado em vez de enfileirar.
- `exclusive` coordena a própria aba; entre abas, `Flow` e as limpezas do `Toi` seguram Web Locks ([ADR 0006](0006-web-locks-cross-tab.md)).
