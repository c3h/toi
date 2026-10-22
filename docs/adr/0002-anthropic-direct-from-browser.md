# A Anthropic é chamada direto do navegador, atrás de uma porta

A v1 fala com um único Provedor. A chamada sai do navegador com `anthropic-dangerous-direct-browser-access: true`, header que a Anthropic exige para aceitar CORS; sem ele a resposta é `authentication_error: CORS requests must set ...`. O preflight de `POST /v1/messages` e `GET /v1/models` responde 200 com `access-control-allow-origin: *` e permite esse header. A organização pode desligar CORS nas configurações, e nesse caso a chamada falha mesmo com o header.

A integração fica atrás da porta `ChatProvider`, com Eventos normalizados. O adaptador é o único lugar que conhece `x-api-key`, `anthropic-version` e os eventos de conteúdo da Anthropic.

## Considered Options

- **Proxy próprio (Worker)**: resolveria qualquer bloqueio de CORS e esconderia a Chave do DevTools, mas faria o proxy ver a Chave e as Conversas. Só entra se um Provedor bloquear CORS de forma incontornável.
- **SDK oficial `@anthropic-ai/sdk`**: traria o parser de SSE pronto. Preterido porque o contrato que queremos é o de Eventos do domínio, e o SDK adicionaria uma segunda camada de tipos sobre o mesmo HTTP. Se o custo de manter o parser e os mappers superar o do SDK, reavaliar.

## Consequences

- A Chave é legível por qualquer JavaScript da origem. O modelo de ameaça está em `docs/architecture.md` §8; a mitigação é CSP rígida, zero terceiros e nenhuma renderização de HTML cru.
- O header `anthropic-dangerous-direct-browser-access` só é enviado para `api.anthropic.com`, nunca para outra origem.
- Um segundo Provedor entra como novo adaptador da mesma porta. Não sai sem tocar em domínio e UI como se previa: Conversa e Mensagem gravam o Provedor e a UI lê um descritor ([ADR 0008](0008-provider-and-protocol.md)).
