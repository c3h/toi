# Toi — regras de trabalho

## Prioridades

1. O dado não sai da máquina.
2. Previsibilidade sob falha: cancelamento, recarga e Fluxo parcial têm estado explícito.
3. Leveza medível, não aspiracional.

## Fronteiras

- `src/domain` não importa React, Dexie nem `fetch`.
- Toda chamada de rede vive em `src/adapters`.
- A UI não conhece detalhes de nenhum Provedor.
- Nenhum dado é enviado a lugar nenhum além de `api.anthropic.com`.

## Proibido sem decisão explícita

- telemetria, analytics, fonte ou script de terceiro;
- segundo Provedor;
- backend, login ou sincronização;
- guardar a Chave fora do store `credentials`.

## Qualidade

- Teste não usa `sleep`; tempo é controlado por fake timers.
- Erro de Provedor é tipado; a UI nunca mostra a mensagem crua da API.
- Todo Fluxo tem cancelamento e estado final.
- Mensagem `streaming` órfã (Lock da Conversa livre ou, sem Web Locks, lease vencido ou ausente) vira `interrupted`.
- Uma Conversa recebe Mensagens de uma aba por vez; lock ocupado é `flow_busy`, nunca espera.
- Nenhuma Mensagem é mutada, exceto a última do assistant ao tentar de novo.

## Documentação

- `CONTEXT.md`: vocabulário canônico.
- `docs/architecture.md`: desenho e escopo.
- `docs/adr/`: decisões e porquês.
- README é porta de entrada; não duplique nele escopo, stack ou números medidos.
- Não repita conteúdo entre docs: linke a fonte.
- Mudou uma decisão? Atualize o ADR na mesma entrega.
