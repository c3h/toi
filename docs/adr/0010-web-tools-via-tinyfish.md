# O Modelo busca e lê a web por Ferramentas que o toi executa na TinyFish

O Modelo responde mal o que depende de fato recente. Decidimos oferecer duas Ferramentas, Busca (`web_search`) e Leitura (`web_fetch`), que o Modelo pede durante a resposta e o toi executa do navegador num Serviço, a TinyFish. Basta a pessoa gravar a Chave da TinyFish em Configurações: não há toggle, e com a Chave as Ferramentas são oferecidas em todo envio. Sem Chave, nenhum dado vai à TinyFish.

A TinyFish tem REST documentado em JSON, erros tipados, CORS `*` nos dois hosts (`api.search.tinyfish.ai` e `api.fetch.tinyfish.ai`, inclusive no 401) e uso pessoal grátis (30 Buscas/min, 12 mil/dia). A Chave vai só no header `X-API-Key` e só para esses hosts.

## O que sai e para quem

- A consulta da Busca e as URLs da Leitura, escolhidas pelo Modelo. Como podem carregar dado da Conversa, inclusive por prompt injection de uma página lida, isso foi aceito de forma explícita, e a copy de Configurações o diz.
- Os termos da TinyFish permitem treinar com o que ela recebe. Configurações diz isso antes da Chave e linka os termos.
- **Elegibilidade de URL:** a Leitura só aceita URLs que já estão na Conversa: as Fontes de resultados gravados, as URLs que a pessoa escreveu (com ou sem esquema) e as Fontes das Rodadas anteriores da resposta em curso (`domain/web.ts`, `eligibleUrls`). A comparação é exata depois de `new URL()`: fragmento e porta default saem, `http` e `https` se igualam, e path e query ficam intactos. URL com credenciais embutidas é recusada. Sai para a TinyFish a forma comparada (sem fragmento, em `https`), nunca a string que o Modelo escreveu. Garantia: **o Modelo não consegue construir um destino novo nem acrescentar dados a uma URL elegível.** O resíduo está em `architecture.md` §8.

## Como a resposta corre

Uma resposta é uma ou mais **Rodadas**. Cada Rodada envia o prefixo do turno, montado uma vez, mais as Rodadas já fechadas. O prefixo é o histórico selecionado, os Anexos, as Ferramentas, a data e o idioma, e não muda porque a `signature` do raciocínio o amarra. Uma Rodada que termina em `tool_use` executa as chamadas em paralelo e abre a próxima. Os tetos existem contra loop descontrolado:

- 10 chamadas por turno; acima disso, `tool_call_limit` sem rede;
- 12 Rodadas: as chamadas da 11ª recebem `tool_call_limit` sem rede, para a última concluir, e a 12ª ainda pedindo Ferramenta fecha em `tool_limit`;
- 3 URLs por Leitura;
- 15 mil caracteres por resultado.

Raciocínio passa a ser gravado (`reasoning` com `signature`, `redacted_reasoning`), porque a Anthropic exige o da resposta que pediu Ferramentas na Rodada seguinte. Só volta ao Provedor dentro da resposta em curso.

## Considered Options

- **Exa**: avaliada primeiro. A TinyFish venceu pelos erros tipados, pela cota grátis e pelo Fetch em lote com falha por URL.
- **Ferramentas do servidor da Anthropic (`web_search`/`web_fetch`)**: nenhum host novo, mas cobradas por busca na conta da pessoa e presas a um Provedor.
- **Toggle por envio**: mais controle, mas é mais uma decisão por mensagem. A Chave já é o consentimento, e remover a Chave desliga as Ferramentas.
- **Leitura de qualquer URL**: mais útil, mas o Modelo poderia montar uma URL com dado da Conversa e mandá-la a um terceiro.

## Consequences

- `AGENTS.md` libera os hosts da TinyFish só com Chave. A CSP (`connect-src`) ganha os dois hosts.
- A Chave passa a ser **por dono**, de um Provedor ou de um Serviço, no mesmo store `credentials`. O keyPath continua `provider`, porque trocar o keyPath na mesma versão do Dexie abre o banco, mas toda gravação falha com `DataError`. `toi.connected()` continua sendo só do Provedor, para que uma Chave da TinyFish sozinha não pule o onboarding.
- A Chave do Serviço é validada com uma Busca sem `query`: 400 prova a Chave sem gastar cota e 401 a recusa. Isso ainda precisa ser confirmado com Chave real.
- Remover a Chave do Serviço roda em `flow.exclusive` e para a resposta em curso desta aba. As outras abas seguem com a Chave até recarregar, como acontece com a do Provedor.
- Partes de Ferramenta voltam ao Provedor que as gerou e só quando o envio oferece Ferramentas, e só as Rodadas seguidas de texto: uma resposta antiga que termina em resultado faria a pergunta seguinte continuar a Rodada, o que a Anthropic só aceita com o raciocínio dela. Fora disso, só o texto volta ([ADR 0008](0008-provider-and-protocol.md)). Resultados antigos são trocados por um marcador com as Fontes antes do corte de turnos, como os Anexos ([ADR 0009](0009-attachments-inline-local.md)).
- O orçamento de contexto reserva o **espaço das Rodadas**, que a pessoa escolhe em Configurações entre 20 mil, 40 mil (padrão) e 80 mil tokens, sem passar da metade do orçamento. O espaço também vale durante a resposta. O que as Rodadas somam conta a saída do Modelo pelo uso informado pelo Provedor, porque o raciocínio volta inteiro mesmo quando o texto dele chega vazio, e os resultados pela estimativa. Uma chamada só sai se um resultado no teto ainda cabe no espaço, guardando `max_tokens` para a Rodada que conclui; a que não cabe recebe `tool_call_limit` sem rede. Se o Modelo insiste em Ferramentas e as Rodadas passam do espaço, a resposta fecha em `tool_limit`, antes de abrir outra Rodada. A requisição passa do espaço no máximo pela saída de uma Rodada, coberta pela folga de 20% do orçamento. A primeira versão reservava o pior caso dos tetos (10 resultados mais 12 × `max_tokens`, cerca de 141 mil tokens), o que deixava uns 19 mil ao histórico num Modelo de 200 mil mesmo quando o Modelo não buscava nada.
- `tool_result.content` fica dentro da Mensagem. Se uma Conversa com muitas Leituras gerar long task no `watchMessages`, o conteúdo vai para um store próprio, como os Anexos.
- Os timeouts são provisórios até a prova com URLs lentas: 20 s na Busca, 90 s na Leitura e 25 s por URL.
