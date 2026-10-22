# Toi

Chat local-first: a pessoa conversa com modelos da Anthropic direto do navegador. Nada é gravado em servidor; a única saída da máquina é a Conversa enviada à Anthropic para gerar a resposta.

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
Um bloco de conteúdo dentro de uma Mensagem: `text`, `file` ou `reasoning`. A Mensagem do user nasce com os Anexos, um `file` cada, e o texto; a do assistant pode começar vazia e receber texto durante o Fluxo. O schema já prevê `reasoning`.
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

**Chave**:
A credencial de um Provedor fornecida pela pessoa, guardada apenas no navegador; uma por Provedor.
_Avoid_: Token, secret, senha

**Exportação**:
Um retrato do histórico Local num arquivo versionado, que nunca contém a Chave.
_Avoid_: Backup (backup é o uso que a pessoa faz do arquivo), dump

**Título**:
O nome curto de uma Conversa, derivado da primeira Mensagem do user: do texto ou, sem texto, do nome do primeiro Anexo.
_Avoid_: Nome, assunto
