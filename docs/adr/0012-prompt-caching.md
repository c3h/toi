# Todo pedido à Anthropic liga o cache automático de prompt

Cada envio reenvia a Conversa inteira, com os Anexos e, com Ferramentas, as Rodadas antigas; cada Rodada reenvia o turno. Sem cache, a API processa de novo o prefixo inteiro a cada requisição: a entrada custa cheia e o tempo até o primeiro token cresce com a Conversa. Decidimos que todo `POST /v1/messages` leva `cache_control: {type: "ephemeral"}` no topo do corpo, o cache automático: a API põe o breakpoint no último bloco cacheável e o move conforme a Conversa cresce, e o pedido seguinte que começa pelo mesmo prefixo lê do cache o que já foi processado. A leitura custa uma fração da entrada (0,1× na maioria dos Modelos) e a escrita 1,25×.

- **Constante do Protocolo.** `toAnthropicPayload` (`adapters/protocols/anthropic-messages/request.ts`) põe o campo em todo pedido, sem parâmetro: o cache é do formato e não depende do Modelo nem do Provedor. A porta `ChatProvider`, o domínio e a UI não mudam. O pedido do Título também leva, sem caso especial; ele não se repete, então paga a escrita de 1,25× sobre uns mil tokens uma vez por Conversa.
- **TTL padrão de 5 min**, sem `ttl`. Cada leitura renova o prazo, então a Conversa ativa e as Rodadas de um turno ficam no cache.
- **ZDR-elegível.** O cache não guarda prompt nem resposta: representações KV e hashes ficam em memória pelo TTL e são apagados depois. O destino continua só `api.anthropic.com`, e o cache é isolado por workspace da Chave. A Files API foi recusada justamente por reter fora de ZDR ([ADR 0009](0009-attachments-inline-local.md)).
- Abaixo do mínimo cacheável do Modelo (de 512 a 4096 tokens), a API não cacheia e não dá erro: a Conversa curta só não ganha nada.

## O que mantém o prefixo estável

A API compara o prompt na ordem `tools`, `system`, `messages`; um byte diferente invalida tudo depois dele.

- **Entre Rodadas:** o prefixo do turno (histórico selecionado, Anexos, Ferramentas com a data e o idioma) é montado uma vez (`app/send-message.ts`), e cada Rodada só acrescenta no fim as já fechadas (`continuationOf`). O pedido da Rodada n+1 começa pelo da Rodada n inteiro.
- **Entre turnos:** o histórico é recalculado do zero, mas sem corte sai igual: a Mensagem gravada não muda, Modelo e Esforço vêm do envio e os bytes do Anexo são os gravados. O histórico e `continuationOf` aparam o texto do mesmo jeito (`app/build-request.ts`), para a Rodada enviada num turno voltar byte a byte no seguinte.
- **Tentar de novo** com o mesmo Modelo e Esforço reenvia o pedido da resposta que substitui e lê do cache o prefixo inteiro.
- `tests/tool-loop.test.ts` e `tests/send-message.test.ts` fixam isso comparando o corpo do Protocolo pedido a pedido (`expectCachedPrefix`): entre Rodadas, entre turnos com Ferramentas sem raciocínio e entre dois envios, de texto e com Anexo.

## Perdas conhecidas e aceitas

- **O raciocínio do turno anterior não volta.** Com Ferramentas, as Rodadas do turno T voltam no turno T+1 sem o raciocínio, que costuma ser o primeiro bloco da resposta: o pedido de T+1 diverge logo depois da pergunta de T e reescreve as Rodadas de T a 1,25×. A busca da entrada anterior olha no máximo 20 posições para trás, e uma sequência de `tool_use` conta uma posição, como uma de `tool_result`; cada Rodada ocupa 2 posições, ou 3 com texto antes das chamadas. A partir de umas 6 a 9 Rodadas em T, a entrada da pergunta de T sai do alcance e o envio de T+1 reescreve a Conversa inteira. A mesma janela vale para uma Mensagem perto do teto de 20 Anexos. Sem Ferramentas não há perda: a resposta nunca esteve num pedido anterior. Reenviar o raciocínio exigiria guardar em que prefixo cada bloco nasceu, ou o beta `drop_block`: a elisão e o corte de turnos mudam o histórico antes de blocos que voltariam, e o *preserved thinking* recusa o bloco cujo prefixo mudou. Descartar o raciocínio de todos os turnos anteriores é remover uma sequência inicial de blocos, o que a API aceita.
- **O corte no teto do contexto** (`architecture.md` §7) tira turnos do meio, e cada envio seguinte corta num ponto diferente: o prefixo diverge logo depois do primeiro turno, e o resto é reescrito a cada envio. A elisão de Anexos e resultados antigos reescreve a partir do marcador novo.
- **A data da Busca** ("Today is", em `app/web-tools.ts`) está na definição da Ferramenta, que abre o prefixo: o primeiro envio de cada dia, no fuso da pessoa, reescreve a Conversa inteira.
- **Editar as Instruções** reinicia o cache de todas as Conversas: elas vão em `system`, que vem antes das Mensagens ([ADR 0013](0013-instructions.md)).
- **Trocar o Modelo, o Esforço ou a Chave do Serviço** reinicia o cache: o cache é por Modelo, a API renderiza o Esforço no prompt, e a Chave do Serviço põe ou tira as Ferramentas do começo do prefixo e as Partes de Ferramenta antigas do histórico. O espaço das Rodadas muda o orçamento do histórico, então reinicia o cache quando a Conversa está no teto.
- **A pessoa que volta depois de 5 min** reescreve a Conversa, e a Conversa de um turno paga a escrita sem leitura.

## Considered Options

- **Sem cache:** nenhuma escrita a 1,25×, mas a Conversa longa e cada Rodada pagam o prefixo cheio.
- **TTL de 1 h:** cobre quem volta entre 5 e 60 min, mas a escrita custa 2× em todo pedido e o cache fica 12 vezes mais tempo na Anthropic.
- **Breakpoints explícitos além do automático:** um a cada ~15 posições cobriria as Rodadas longas, mas o Protocolo passaria a contar blocos para um caso de 6 Rodadas ou mais.
- **Decisão do Provedor, como o `thinking`:** nenhum Modelo ou Provedor recusa o campo hoje, e seria um parâmetro sem segundo valor. Passa ao Provedor quando um Provedor que fale o Protocolo o recusar ([ADR 0008](0008-provider-and-protocol.md)).
- **Pré-aquecer o cache enquanto a pessoa digita:** tiraria a espera da primeira escrita, mas manda a Conversa antes do envio.

## Consequences

- O uso gravado na Mensagem já separa leitura e escrita de cache (`architecture.md` §5). Cada perda acima aparece no uso como `cache_creation_input_tokens` alto e `cache_read_input_tokens` baixo no mesmo envio.
- Medir de novo, com o uso gravado de Conversas reais, quando: a leitura ficar em zero entre envios com o mesmo Modelo e Esforço (um invalidador novo no prefixo); turnos com 6 Rodadas ou mais ou Conversas no teto do contexto forem comuns (breakpoint explícito, corte em degraus ou `drop_block` passam a valer o custo); a pessoa voltar em geral entre 5 e 60 min (TTL de 1 h); a API mudar a janela de 20 posições, o mínimo cacheável ou a regra do *preserved thinking*.
