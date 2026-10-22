# Mensagem é uma lista ordenada de Partes; Fluxo é uma sequência de Eventos normalizados

Uma Mensagem não é uma string. O assistant pode produzir raciocínio e texto na mesma resposta, em ordem, e vai produzir ferramentas e imagens depois. Guardar `content: string` obrigaria a migrar todo o histórico quando o segundo tipo de Parte aparecesse. Modelamos `Message.parts` como uma lista ordenada de `Part` (`text`, `file`, `reasoning`, `redacted_reasoning`, `tool_call`, `tool_result`); a ordem na lista é o índice da Parte.

O Fluxo segue a mesma lógica: o adaptador traduz os eventos da Anthropic para um conjunto pequeno de Eventos do domínio (`started`, `part_started`, `delta`, `part_finished`, `usage`, `finished`) e ignora tipos desconhecidos, como a documentação recomenda. A UI nunca vê `content_block_delta`.

## Considered Options

- **String única + metadados**: simples até a primeira resposta com raciocínio ou ferramenta; depois exige migração de dados persistidos.
- **Tipos da Anthropic vazando para o domínio**: menos código no adaptador, mas prende o domínio a um Provedor e contamina a UI.

## Consequences

- O schema já separa Partes por tipo e ordem; acrescentar `tool_use`, `tool_result` ou `image` é um novo membro da união, não uma migração de conteúdo.
- O renderizador decide o que mostrar por Parte.
- ~~Raciocínio fica fora da v1.~~ Superado em 2026-10-22 pelo [ADR 0010](0010-web-tools-via-tinyfish.md): `thinking` vira `reasoning` com `signature` e `redacted_thinking` vira `redacted_reasoning`, gravados porque a Rodada seguinte de uma resposta com Ferramentas os exige. `tool_use` e `tool_result` entraram como novos membros da união, sem migração, como previsto.
- Cada adaptador novo traduz para os mesmos Eventos; o custo é um mapper por Provedor.
- A porta `ChatProvider` também recebe Partes, não texto: `ChatMessage.parts` e campo próprio para `system`. Parâmetros de amostragem (`temperature`, `top_p`, `top_k`) ficam fora da porta: a API da Anthropic os removeu na versão `2026-10-21`. O adaptador traduz `reasoning` em `thinking` com `signature`; o `build-request` decide o que volta ao Provedor: raciocínio só dentro da resposta em curso, Partes de Ferramenta só ao Provedor que as gerou.
