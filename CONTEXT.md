# Toi

Chat local-first: a pessoa conversa com modelos da Anthropic direto do navegador. Nada é gravado em servidor; a Conversa sai da máquina para a Anthropic gerar a resposta e, com a Chave da TinyFish, as consultas e URLs que o Modelo pede vão a ela ([ADR 0010](docs/adr/0010-web-tools-via-tinyfish.md)).

Vocabulário canônico do projeto. Se um termo aparecer em `docs/architecture.md`, vale o significado daqui.

## Vocabulário

**Local**:
Um dado que existe apenas no perfil do navegador onde foi criado. Não há cópia em servidor, conta ou sincronização.
_Avoid_: Offline, privado (privacidade é consequência, não o significado)

**Conversa**:
A unidade de histórico: uma sequência ordenada de Mensagens, com Título, Modelo, Esforço e timestamps.
_Avoid_: Chat, thread, sessão

**Mensagem**:
Uma fala de um papel — `user` ou `assistant` — dentro de uma Conversa. Contém Partes e um Estado.
_Avoid_: Bolha, resposta (a resposta é uma Mensagem do assistant)

**Parte**:
Um bloco de conteúdo dentro de uma Mensagem: `text`, `file`, `reasoning`, `redacted_reasoning`, `tool_call` ou `tool_result`. A Mensagem do user nasce com os Anexos, um `file` cada, e o texto; a do assistant pode começar vazia e recebe, em ordem, raciocínio, texto, chamadas de Ferramenta e os resultados delas durante o Fluxo.
_Avoid_: Bloco, chunk, conteúdo

**Anexo**:
Um arquivo — imagem, PDF ou texto — que a pessoa junta a uma Mensagem. É preparado e guardado no navegador; a Parte `file` guarda só os metadados, e os bytes vão inline a cada requisição que o inclui ([ADR 0009](docs/adr/0009-attachments-inline-local.md)).
_Avoid_: Arquivo (em texto corrido), upload, documento

**Estado da mensagem**:
O ciclo de vida de uma Mensagem: `complete`, `streaming`, `interrupted` ou `failed`. A recuperação na abertura está em `docs/architecture.md` §4.
_Avoid_: Status, flag

**Fluxo**:
A sequência de Eventos que o Provedor emite enquanto produz uma Mensagem do assistant.
_Avoid_: Stream (em texto corrido), resposta parcial

**Rodada**:
Uma ida e volta ao Provedor dentro de uma Mensagem do assistant. A Rodada que termina pedindo Ferramenta abre a seguinte, com os resultados. O **espaço das Rodadas** é quanto elas podem somar à requisição de uma resposta, escolhido pela pessoa.
_Avoid_: Turno (turno é a pergunta da pessoa e a resposta inteira), passo, iteração

**Evento**:
Uma atualização atômica dentro de um Fluxo: `started`, `part_started`, `delta`, `part_finished`, `usage` ou `finished`.
_Avoid_: Chunk, packet

**Lock da Conversa**:
O direito exclusivo de uma aba de escrever Mensagens numa Conversa. Some quando a aba fecha; Mensagem `streaming` numa Conversa sem dono autoriza a recuperação a marcá-la como `interrupted`.
_Avoid_: mutex

**Provedor**:
O serviço externo que gera Mensagens, com Chave e lista de Modelos próprias. Hoje, apenas a Anthropic.
_Avoid_: Backend, API, modelo

**Protocolo**:
O formato de API em que um Provedor atende um Modelo: payload, stream e envelope de erro. Um Provedor pode falar mais de um Protocolo, e um Protocolo pode servir mais de um Provedor.
_Avoid_: Provedor (quando se fala do formato), dialeto, SDK

**Modelo**:
Um identificador oferecido pelo Provedor, descoberto pela API e escolhido pela pessoa. Só é único junto com o Provedor.
_Avoid_: Engine, LLM

**Esforço**:
O quanto o Modelo raciocina e gasta numa resposta, numa escala de cinco níveis (`low` a `max`), escolhido pela pessoa ao lado do Modelo e sempre enviado. Todo Modelo oferecido aceita a escala inteira.
_Avoid_: Effort (em texto corrido), nível de raciocínio, padrão

**Ferramenta**:
Uma ação que o Modelo pede durante a resposta e o toi executa num Serviço: a **Busca** (`web_search`), que devolve trechos e Fontes, e a **Leitura** (`web_fetch`), que lê páginas cuja URL já está na Conversa.
_Avoid_: Tool (em texto corrido), plugin, função

**Serviço**:
O serviço externo que executa as Ferramentas, com Chave própria. Hoje, apenas a TinyFish. Não gera Mensagens; isso é do Provedor.
_Avoid_: Provedor, API de busca

**Fonte**:
O título e a URL de uma página que uma Ferramenta achou ou leu. As Fontes gravadas tornam a URL elegível para Leitura na Conversa.
_Avoid_: Citação, link, referência

**Chave**:
A credencial de um Provedor ou de um Serviço fornecida pela pessoa, guardada apenas no navegador; uma por dono.
_Avoid_: Token, secret, senha

**Exportação**:
Um retrato do histórico Local num arquivo versionado, que nunca contém a Chave.
_Avoid_: Backup (backup é o uso que a pessoa faz do arquivo), dump

**Título**:
O nome curto de uma Conversa, derivado da primeira Mensagem do user: do texto ou, sem texto, do nome do primeiro Anexo.
_Avoid_: Nome, assunto
