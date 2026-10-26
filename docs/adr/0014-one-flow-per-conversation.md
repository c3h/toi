# Cada Conversa tem o seu Fluxo, e Conversas diferentes respondem em paralelo

O `Flow` guardava um Fluxo por aba: enquanto uma Conversa respondia, a pessoa não conseguia perguntar em outra, nem numa nova. A restrição só existia dentro da aba. Entre abas, o lock já era por Conversa ([ADR 0006](0006-web-locks-cross-tab.md)), assim como o `seq`, o flush e a recuperação na abertura. Nenhuma invariante dependia de um Fluxo por aba.

Decidimos que o `Flow` mantém um Fluxo por Conversa. `send` e `retry` recusam com `flow_busy` só na mesma Conversa ou durante uma limpeza. `stop(conversationId)` para a Conversa dada, e `flush()` grava todos os Fluxos. `active()` devolve o conjunto de Conversas em Fluxo, com a mesma identidade até um Fluxo começar ou terminar, e `watch` avisa essas mudanças, nunca a cada Evento. Supera a consequência "um `Toi` tem no máximo um Fluxo ativo" do [ADR 0005](0005-flow-as-module.md). O que ela protegia continua por Conversa: recusar em vez de enfileirar, estado final explícito em todo Fluxo e uma Mensagem do user por vez.

## Como funciona

- **O Flow é a fonte do "respondendo".** A UI lê `active()` por `useSyncExternalStore` e não guarda cópia. A barra lateral marca cada Conversa em Fluxo, e o composer fica desabilitado só na que responde; esc e "parar" param a Conversa à vista.
- **Limpezas param todos antes de esperar qualquer um.** `exclusive(task)` aborta todos os Fluxos, espera todos fecharem e só então roda a limpeza; com `conversationId`, só aquela Conversa. Apagar uma Conversa não toca o Fluxo de outra.
- **Um aviso por Conversa.** O aviso de um Fluxo (contexto truncado, resposta não salva, erro ao começar) é da Conversa dele: o de um Fluxo que termina em segundo plano espera a pessoa abrir a Conversa e nunca aparece na de outra. Sair da Conversa o dispensa, como antes.
- **Resposta que terminou sem ser gravada fica retida.** Quando o flush final falha, o `Flow` guarda a Mensagem fechada, e `watchMessages` a entrega no lugar da gravada. Antes, ela só vivia na tela aberta; com Fluxos em segundo plano, sair e voltar mostraria a gravação do meio, `streaming` e sem Fluxo. O próximo envio ou tentativa na Conversa a grava primeiro, sob o lock, para o histórico enviado ser o que a pessoa vê; se gravar falha de novo, o envio recusa com `storage_failed` sem chamar o Provedor. A cópia só sai quando é gravada, e só substitui a Mensagem gravada, nunca a acrescenta: apagada a Conversa, ela não volta à tela.
- **O Título é cancelável desde o começo.** A tentativa entra no registro antes de escolher o Modelo do Título. Apagar uma Conversa ou o histórico a cancela depois de os Fluxos pararem, então um Fluxo que terminou no meio da limpeza não pede Título de Conversa apagada. Remover a Chave cancela também as que ainda escolhem o Modelo, cuja escolha poderia terminar antes de a conexão sair.

## Considered Options

- **Um Fluxo por aba** (decisão anterior): menos estado na UI, ao custo de travar perguntas independentes.
- **Fila de envios:** esconde espera atrás do envio e contradiz "lock ocupado é `flow_busy`, nunca espera".
- **Teto de Fluxos simultâneos:** nenhuma medição o justifica. Cada Fluxo nasce de um envio explícito, e 429 do Provedor já fecha a Mensagem com erro tipado e "tentar de novo".

## Consequences

- Cada Fluxo paralelo custa o próprio pedido (histórico, Anexos e corpo), um flush a cada 300 ms e o parse do SSE. O que ele renderiza fora da Conversa aberta e o orçamento de long task com dois Fluxos estão em `architecture.md` §9.
- Os limites de taxa da Chave são gastos mais rápido. A espera depois de um 429 da TinyFish continua por turno, então Fluxos paralelos podem gastar um lote de chamadas cada um antes de ver o primeiro 429.
- O rascunho do composer continua único entre Conversas.
