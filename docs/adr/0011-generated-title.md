# O Título é gerado por um Modelo leve quando a primeira resposta termina

Supera a linha de `architecture.md` que dizia "Nenhuma chamada extra ao Modelo só para nomear".

O corte dos ~60 primeiros caracteres da primeira Mensagem nomeia mal justo as Conversas difíceis de reencontrar: "me ajuda com isso", uma pergunta que começa pelo contexto, uma Mensagem só com Anexo. Decidimos que, quando a primeira resposta termina `complete`, a aba que a enviou faz uma chamada extra ao **Modelo do Título** com o texto da primeira Mensagem e o começo da resposta, e grava o Título curto que ele escreve. O corte continua sendo o Título imediato e o que fica em qualquer falha.

## O que a decisão anterior protegia

- **Custo na Chave da pessoa.** Uma chamada por Conversa, uma vez, com no máximo 2 mil caracteres da pergunta e 2 mil da resposta, sem Anexos, raciocínio nem resultados de Ferramenta, e saída de poucas palavras. No Haiku 5.5 sem raciocínio isso fica em torno de mil tokens de entrada, uma fração de centavo; a própria resposta reenviada no envio seguinte custa mais.
- **Previsibilidade.** A chamada tem estado final explícito (`named`, `kept`, `failed`, `aborted`), corre fora do Fluxo e do lock da Conversa, não tenta de novo e nunca mostra erro: o pior caso é o Título de hoje.
- **O dado não sai da máquina.** O que vai já foi ao mesmo Provedor nessa Conversa.

## Como funciona

- `app/name-conversation.ts` faz um pedido pelo mesmo `ChatProvider.stream`, com `reasoning: 'off'`, o menor Esforço, `tools: []` e um teto de 1.024 tokens, e aceita o texto só com `finished` e `end_turn`. O prazo é de 20 s. `domain/conversation.ts` (`cleanTitle`) tira aspas, marcação e ponto final e corta como o derivado.
- `Conversation.titleSource` (`derived`, `generated`, `manual`) protege a pessoa: o Título gerado e o derivado só são gravados sobre um `derived` (`retitle`), dentro da transação de `updateConversation`/`startTurn`, então renomear antes da chamada voltar, nesta aba ou em outra, vence. Nomear não toca `updatedAt`, então não reordena o histórico. Conversa apagada no meio não é recriada.
- `app/toi.ts` dispara a chamada depois de `flow.send`, só para a primeira resposta gravada sem erro (`RunResult.opening`, lido por `firstExchange`). Tentar de novo e os envios seguintes não disparam. Apagar a Conversa, apagar tudo, remover ou trocar a Chave do Provedor cancelam a chamada pendente. Fechar a aba no meio deixa o derivado, sem retomada.
- **Modelo do Título:** a pessoa escolhe em Configurações entre os Modelos do seletor; sem escolha, vale a versão mais recente da família que o Provedor sugere (`ProviderInfo.titleFamily`, Haiku na Anthropic). Se a escolha sai do seletor, ou nenhum Modelo da família sugerida está nele, nenhuma chamada sai e Configurações avisa; não há troca silenciosa por um Modelo mais caro.
- **Raciocínio desligado** é um campo do pedido, não um nível de Esforço. A listagem da Anthropic não diz quem desliga o raciocínio, então a regra fica no Provedor (`providers/anthropic/thinking.ts`), que entrega o valor pronto ao Protocolo: `{type: "disabled"}` no Haiku 5.5, no Opus 5 e nos anteriores, `{type: "between_tools"}` no Sonnet 5.5, e nenhum `thinking` no Opus 5.5, no Fable e em Modelo fora da regra, que raciocinam no Esforço mínimo. `Model.reasoningOff` leva isso à UI, que avisa quando o Modelo escolhido sempre raciocina.

## Considered Options

- **Pedir o Título na própria resposta**, por tag ou Ferramenta: nenhuma chamada extra, mas suja a resposta, acopla o Título ao Fluxo e às Rodadas e piora com raciocínio e Ferramentas.
- **Chamar no envio, só com a pergunta:** o Título chega antes, mas é pior quando a pergunta é vaga ou só um Anexo, e o Título provisório já cobre a espera.
- **Esconder do seletor do Título os Modelos que sempre raciocinam:** a lista deixaria de ser a do chat; preferimos a mesma lista com o aviso.

## Consequences

- O schema `version(1)` ganha `titleSource` em `conversations`, sem índice; o cache de Modelos ganha `reasoningOff`. A Exportação não leva `titleSource`, que só serve à proteção entre abas.
- A regra de raciocínio desligado é mantida à mão: um Modelo novo raciocina no Esforço mínimo até entrar nela, o que nunca dá 400.
