# Anexos ficam no navegador e vão inline em cada requisição

A pessoa anexa imagens, PDFs e arquivos de texto a uma Mensagem. O toi não tem backend, e a Conversa só sai da máquina para a Anthropic. Decidimos que o Anexo é preparado e gravado no navegador e vai inline, em base64 ou texto, a cada requisição que o inclui. A Parte `file` da Mensagem guarda só os metadados (nome, tamanho, dimensões, páginas); os bytes ficam num store próprio, `attachments`, com `conversationId` para a cascata. Gravar os bytes na Mensagem faria o `watchMessages` reler megabytes a cada flush de 300 ms.

O tipo vem dos bytes, não da extensão nem do MIME do navegador. Imagem passa sempre pelo canvas: aplica a rotação EXIF, tira metadados como GPS, limita o lado maior a 2000 px e sai em PNG (origem PNG/GIF ou com transparência) ou JPEG. PDF vai como está, como `document` base64; as páginas são contadas nos bytes, inclusive dentro de object streams. Texto é UTF-8 estrito e vai como `document` de texto, com o nome do arquivo como título, separado da fala da pessoa.

Cada requisição respeita quatro tetos da API: bytes (32 MB), páginas de PDF e blocos de imagem ou documento (100 abaixo de 1 milhão de tokens de contexto, 600 acima) e tokens. Uma Mensagem nunca passa sozinha dos tetos que valem para qualquer Modelo (20 arquivos, 20 MB, 100 páginas), então o turno atual sempre cabe. O histórico que passa de um teto perde primeiro os Anexos mais antigos, trocados na requisição por um marcador que diz que o arquivo saiu do contexto; só depois o corte de turnos por tokens corta texto. A Mensagem gravada nunca muda.

## Considered Options

- **Files API (`/v1/files`)**: o arquivo subiria uma vez e cada requisição levaria só o id. Mas o arquivo fica retido no workspace da Chave, fora de Zero Data Retention, e o endpoint não aceita CORS do navegador.
- **Bytes dentro da Mensagem**: uma leitura só, mas cada flush do Fluxo e cada mudança de outra aba relê todos os bytes da Conversa.
- **Mandar a imagem original**: preserva fidelidade, mas leva EXIF com localização, depende de o formato ser aceito pela API e deixa o tamanho sem teto.
- **Últimos N Anexos em vez de tetos**: mais simples, mas N PDFs grandes ainda estouram páginas ou bytes, e N imagens pequenas saem sem precisar.
- **Cortar turnos antes de Anexos**: preserva a coerência entre um arquivo e a resposta sobre ele, mas bytes e páginas estouram muito antes dos tokens e jogariam fora texto barato.

## Consequences

- O Anexo sai da máquina a cada requisição que o inclui, só para `api.anthropic.com`, como o texto. Tirar EXIF não anonimiza pixels, nomes de arquivo nem o conteúdo de um PDF.
- Apagar uma Conversa ou o histórico apaga os bytes na mesma transação; o envio grava Conversa, Mensagens e Anexos numa transação só, e o navegador sem espaço vira `storage_full` com o rascunho de volta ao composer.
- A contagem de páginas é heurística: PDF cifrado ou fora do padrão fica com `pages: null` e conta como 100. A API recusa o que a heurística deixou passar com `attachment_rejected`.
- A exportação continua `toi.history` versão 1 ([ADR 0007](0007-explicit-persisted-formats.md)): a Parte `file` é um tipo novo, com os bytes em base64, e o arquivo é montado por Mensagem para não criar uma string do tamanho do histórico.
- Resultados de Ferramenta antigos seguem a mesma elisão, trocados por um marcador com as Fontes ([ADR 0010](0010-web-tools-via-tinyfish.md)). Dentro de um turno com Rodadas o prefixo não muda: a `signature` do raciocínio o amarra, e o corte é calculado uma vez, com espaço reservado para as Rodadas.
- Sem cache de prompt, os bytes de todos os Anexos que cabem sobem de novo a cada envio. O corte é recalculado do zero a cada requisição; estabilizar o prefixo é trabalho da entrega de cache, junto com a medição de custo.
