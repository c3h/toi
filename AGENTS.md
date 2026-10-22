# Toi — regras de trabalho

## Prioridades

1. O dado não sai da máquina.
2. Previsibilidade sob falha: cancelamento, recarga e Fluxo parcial têm estado explícito.
3. Leveza medível, não aspiracional.

## Fronteiras

- `src/domain` não importa React, Dexie nem `fetch`.
- Toda chamada de rede vive em `src/adapters`.
- A UI não conhece detalhes de nenhum Provedor ou Serviço.
- Dado sai só para `api.anthropic.com` e, com a Chave da TinyFish gravada, para `api.search.tinyfish.ai` e `api.fetch.tinyfish.ai` ([ADR 0010](docs/adr/0010-web-tools-via-tinyfish.md)).

## Proibido sem decisão explícita

- telemetria, analytics, fonte ou script de terceiro;
- segundo Provedor ou Serviço;
- backend, login ou sincronização;
- guardar a Chave fora do store `credentials`.

## Qualidade

- Teste não usa `sleep`; tempo é controlado por fake timers.
- Erro de Provedor é tipado; a UI nunca mostra a mensagem crua da API.
- Todo Fluxo tem cancelamento e estado final.
- Mensagem `streaming` órfã (Lock da Conversa livre) vira `interrupted`.
- Uma Conversa recebe Mensagens de uma aba por vez; lock ocupado é `flow_busy`, nunca espera.
- Nenhuma Mensagem é mutada, exceto a última do assistant ao tentar de novo.

## Manutenibilidade

Mude o código existente sem medo: quando um módulo deveria mudar, mude o módulo em vez de contorná-lo com lógica local.

O toi está em pré-produção: nenhum código acomoda estado antigo. Imponha a invariante definitiva e atualize a origem e todos os consumidores: o schema é a `version(1)` editada no lugar, campo obrigatório chega preenchido, API do navegador é chamada direto. Shim de compatibilidade, migração, leitura que tolera dado legado e default (`??`, `?.`, valor inventado) para caller ou dado fora do contrato ficam de fora. Ausência legítima do domínio é modelada explicitamente, como o `null` de `firstTokenAt`. Resiliência em runtime (armazenamento bloqueado, Provedor fora do ar, aba que fecha no meio do Fluxo) é comportamento de produto, não legado.

Proteção nova se justifica por um cenário alcançável, seu impacto e sua probabilidade; a complexidade acompanha o risco.

## Documentação

- `CONTEXT.md`: vocabulário canônico.
- `docs/architecture.md`: desenho e escopo.
- `docs/adr/`: decisões e porquês.
- README é porta de entrada; não duplique nele escopo, stack ou números medidos.
- Não repita conteúdo entre docs: linke a fonte.
- Doc registra o que foi decidido. Quando a melhor solução contradiz um ADR, o `CONTEXT.md` ou o `architecture.md`, entregue a melhor solução, com refatoração funda se preciso, e atualize o doc na mesma entrega, marcando o ADR como superado. Para superar, nomeie o que a decisão protege e mostre ganho maior nesses eixos (trecho, medição ou cenário alcançável); sem isso, a decisão fica. As regras deste arquivo só mudam com decisão explícita.
