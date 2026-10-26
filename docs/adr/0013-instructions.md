# As Instruções são um texto global que vai em `system` em toda resposta

A pessoa repete a cada Conversa quem é e como prefere as respostas. Decidimos que ela escreve isso uma vez, em Configurações, e o toi manda o texto como `system` em toda requisição de resposta, em todas as Conversas. O roadmap já previa system prompt; a porta (`ChatRequest.system`) e o Protocolo já o carregavam para o Título, então a entrega não traz dependência, chamada de rede nem store novos.

## O que sai e para quem

- As Instruções vão à Anthropic em toda Rodada de toda resposta. Antes, uma informação pessoal ia só na Conversa em que a pessoa a escreveu; agora ela acompanha todas. A copy de Configurações diz isso junto do campo.
- Com a Busca ligada, o Modelo pode pôr o que está nas Instruções no texto da consulta, que vai à TinyFish. É o resíduo do [ADR 0010](0010-web-tools-via-tinyfish.md) (o texto da Busca) com uma origem a mais; a copy da Busca e a do campo dizem isso. Não há filtro de dado pessoal nem confirmação por consulta: nenhum dos dois protege de forma confiável.
- URL escrita só nas Instruções não autoriza Leitura: a elegibilidade continua vindo das Mensagens do user e das Fontes.
- O que o Modelo escreve a partir das Instruções (resposta, consulta, Título) é gravado e exportado como qualquer Mensagem; apagar as Instruções não apaga essas ocorrências.

## Como funciona

- **Global.** Um texto para todas as Conversas, inclusive as que já existem. Por Conversa exigiria escolher, copiar e decidir precedência sem necessidade demonstrada.
- **Guardado em `settings`** (`instructions`), já normalizado: sem espaço nas pontas, com as quebras de dentro; vazio apaga a linha. Até 4 mil caracteres (`MAX_INSTRUCTIONS_CHARS`): passar disso é recusado ao salvar, nunca cortado. O teto evita colar um documento inteiro num texto que toda Rodada reenvia; é escolha de produto, não medição.
- **Lidas uma vez por resposta**, no início do envio ou da tentativa de novo, junto com o prefixo do turno. Salvar no meio de uma resposta vale a partir do próximo envio, nesta ou em outra aba; tentar de novo usa as atuais. Entre abas, a última gravação vence.
- **Falha ao ler fecha a resposta em `failed`** com `storage_failed`, sem rede. Responder sem elas mudaria o pedido da pessoa em silêncio. O espaço das Rodadas segue o padrão quando não dá para lê-lo porque é um orçamento, não conteúdo da pessoa.
- **Saem do orçamento de contexto** antes de escolher o histórico, como o espaço das Rodadas, e nunca são cortadas. Os bytes não são descontados: 4 mil caracteres não chegam perto da folga entre o teto de bytes do histórico e o da API.
- **Não vão ao Título**, que tem a própria instrução de sistema.
- **Abrem o prefixo do cache de prompt**: `system` vem antes das Mensagens, então editar as Instruções reescreve o cache da próxima resposta em todas as Conversas. É uma perda aceita do [ADR 0012](0012-prompt-caching.md), como trocar o Modelo ou o Esforço.
- **Configurações** só abre o campo depois de ler o texto gravado: um campo vazio por falha de leitura levaria a pessoa a sobrescrever o que não viu. Salvar é explícito; falha ao gravar mantém o rascunho.

## Considered Options

- **Por Conversa, ou global com sobrescrita por Conversa:** mais controle, mas acrescenta seleção, cópia e regras de precedência para um pedido que é "escrever uma vez".
- **Gravar na Mensagem as Instruções usadas:** permitiria saber qual versão gerou cada resposta, mas duplicaria dado pessoal em todo o histórico e na Exportação. O histórico já não reproduz a requisição exata (o corte de contexto não é gravado).
- **Levar as Instruções na Exportação:** a Exportação é um retrato do histórico, não das Configurações; levar a versão atual sugeriria que ela valeu para todas as respostas.
- **Seguir sem as Instruções quando a leitura falha:** a resposta sairia, mas ignorando em silêncio o que a pessoa pediu.

## Consequences

- `ChatRequest.system` passou de opcional a `string | null`.
- Depois de editar as Instruções, não dá para saber pelo histórico qual versão gerou uma resposta antiga.
- "Apagar conversas" mantém as Instruções; "apagar tudo" as leva com o resto das Configurações.
