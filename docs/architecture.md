# Arquitetura

Desenho da v1. Vocabulário em `CONTEXT.md`; decisões em `docs/adr/`. **Estado:** a v1 descrita em §1 está implementada, núcleo e UI. O visual segue o blog do autor (`~/Documents/blog`): Geist Mono, Lora na resposta, laranja como única cor, atalhos de uma tecla.

## 1. Objetivo e escopo

Um chat que responde uma pergunta com um Modelo da Anthropic, com Fluxo, cancelamento e histórico Local, sem backend. A v1 é pequena de propósito; a arquitetura é maior que a v1 para que crescer não exija reescrever o que já existe.

**A v1 faz:**

- adicionar, validar, trocar e remover a Chave;
- listar Modelos via `GET /v1/models` e escolher um, com o Esforço ao lado;
- criar Conversa, enviar Mensagem, receber Fluxo, parar;
- anexar imagens, PDFs e arquivos de texto a uma Mensagem, pelo clipe, colando ou soltando (§6);
- renomear e apagar Conversas na barra lateral;
- apagar todas as Conversas (preserva a Chave) e apagar tudo (remove a Chave);
- persistir e retomar; Mensagem `streaming` órfã vira `interrupted` na abertura;
- coordenar abas: uma Conversa recebe Mensagens de uma aba por vez;
- exportar o histórico em JSON versionado, sem a Chave;
- Markdown e código na resposta;
- tokens de entrada e saída, tempo até o Modelo responder e tokens por segundo por Mensagem;
- Instruções escritas uma vez em Configurações e enviadas em toda resposta ([ADR 0013](adr/0013-instructions.md));
- com a Chave da TinyFish, Busca e Leitura na web durante a resposta, com as Fontes na Mensagem ([ADR 0010](adr/0010-web-tools-via-tinyfish.md)).

**Fora da v1:** conta, sincronização, compartilhamento, i18n, outras Ferramentas, branching e os itens do roadmap (§12).

**Raciocínio é gravado, mas não aparece.** O Modelo raciocina conforme o Esforço; os blocos `thinking` (com `signature`) e `redacted_thinking` viram Partes `reasoning` e `redacted_reasoning`, porque a Anthropic exige o raciocínio da resposta que pediu Ferramentas na Rodada seguinte. Só voltam ao Provedor dentro da resposta em curso; a UI não os mostra.

## 2. Princípios de desenho

1. **Fronteira explícita.** Domínio puro; rede só em adaptadores; a UI só conhece do Provedor o descritor `ProviderInfo` ([ADR 0008](adr/0008-provider-and-protocol.md)).
2. **Uma dependência por problema.** Biblioteca só quando o custo de escrever e manter é maior que o de depender.

As prioridades de produto — dado local, previsibilidade sob falha e leveza medível — e as regras operacionais estão em `AGENTS.md`; o orçamento de leveza está na §9.

## 3. Módulos e dependências

```
src/
  domain/        # tipos e invariantes; zero import externo
  ports/         # contratos e defaults; sem dependência externa
  adapters/
    http/        # sse, fetchOrThrow, Retry-After
    protocols/   # um formato de API por pasta; anthropic-messages: request, stream, error, types
    providers/   # um Provedor por pasta; anthropic: info, fetch, models, provider
    services/    # o Serviço das Ferramentas; tinyfish: info, tools
    storage/     # db, records, conversations, credentials, settings
    locks/       # web (navigator.locks)
    tokens/      # heuristic
  app/           # flow, flusher, toi, locks, recover-interrupted, conversations, export, send-message,
                 # build-request, name-conversation, web-tools (definições, elegibilidade aplicada,
                 # texto ao Modelo, tetos); sem React
  ui/            # React + Tailwind: App, Onboarding, Sidebar, Chat, Prose, Settings (lazy), markdown/ (lazy),
                 # attachments/ (rascunho, chips e diálogo; o preparo é lazy)
  main.tsx       # composition root: injeta os adaptadores concretos em `createToi`
```

`Flow` (`app/flow.ts`) é o módulo do Fluxo em voo e `Toi` (`app/toi.ts`) é a fachada do app, que também conecta as Chaves e compõe as limpezas; a UI depende só dos dois. Responsabilidades e porquê em [ADR 0005](adr/0005-flow-as-module.md).

**Regra de dependência:** `ui → app → ports ← adapters`; todos podem importar `domain`; `domain` não importa ninguém. `app` não importa `adapters` e recebe as implementações por injeção. `main.tsx` é o composition root e injeta as implementações concretas; cada Provedor entra em `Toi` como um `ProviderAdapter` (`info` + `create(key)`) na lista `providers`, e o Serviço como um `ServiceAdapter` em `service`, um só: um segundo Serviço pede decisão (`AGENTS.md`). Provedor e Protocolo são papéis separados dentro de `adapters` ([ADR 0008](adr/0008-provider-and-protocol.md)).

As portas existem por fronteiras reais: `ChatProvider` isola o HTTP de terceiro e permite um segundo Provedor, e `ProviderInfo` é tudo que a UI sabe dele; `WebTools` isola o Serviço das Ferramentas, e `ServiceInfo` é tudo que a UI sabe dele; o storage permite trocar IndexedDB ou usar memória em teste; `Locks` coordena abas por Web Locks; `TokenEstimator` permite substituir a heurística pela contagem exata sem tocar no domínio; `SettingsStore` guarda o cache de Modelos, o último Modelo e o último Esforço, quais Modelos o seletor oferece, o espaço das Rodadas, o Modelo do Título e as Instruções.

## 4. Ciclo de uma Mensagem

`Flow.send` (o caso de uso `startSendMessage`):

1. segura os locks da Conversa (§4, Coordenação entre abas) até o passo 8; sem eles, `flow_busy`;
2. grava numa transação (`startTurn`) a Mensagem do user (`complete`), a do assistant (`streaming`) e os bytes dos Anexos;
3. lê as Instruções, normaliza e seleciona o histórico, busca no store só os Anexos que ficaram e monta o `ChatRequest` com os Blobs, que o adapter lê ao montar o corpo (`build-request`); parar durante a leitura fecha em `interrupted` sem chamar o Provedor, e falhar ao ler as Instruções fecha em `failed`, também sem chamar;
4. consome `provider.stream(request, signal)`;
5. para cada Evento aplicado, atualiza a Parte e agenda o flush (300 ms);
6. se a Rodada terminou em `tool_use`, executa as chamadas e volta ao passo 4 com as Rodadas fechadas (abaixo);
7. fecha em `complete`, `interrupted` ou `failed`;
8. devolve `RunResult` e solta os locks; falha de persistência vai em `persistError`, sem reabrir a Mensagem.

```
streaming ── Rodada fecha, stop ≠ tool_use ───────────► complete   (término lógico)
          ├─ Rodada fecha em tool_use ─► Ferramentas ─► nova Rodada
          ├─ 12ª Rodada ou espaço cheio, em tool_use ─► failed (tool_limit)
          ├─ abort ───────────────────────────────────► interrupted
          └─ erro ────────────────────────────────────► failed
```

### Rodadas e Ferramentas

Decisão em [ADR 0010](adr/0010-web-tools-via-tinyfish.md). Com o Serviço conectado no início do envio, o `ChatRequest` leva as definições de Busca e Leitura, com a data e o idioma do início do turno. O prefixo (Instruções, histórico selecionado, Anexos e Ferramentas) é montado uma vez; cada Rodada envia o prefixo mais as Rodadas já fechadas da resposta, com o raciocínio (`continuationOf`).

- `domain/round.ts` (`applyEvent`) aplica os Eventos à Mensagem, aceitando os blocos em qualquer ordem: o texto aparece a cada delta, o raciocínio só depois de terminado e assinado, e a chamada só com o JSON do input fechado num objeto. Um delta só vale no bloco que um `part_started` abriu.
- As chamadas de uma Rodada correm em paralelo, com o `signal`. O laço espera todas, mesmo depois de um abort, antes de seguir ou soltar o lock. Falha do Serviço vira `tool_result` com erro tipado e a resposta segue; o Modelo lê uma dica em inglês, nunca a mensagem crua.
- Uma chamada só sai se um resultado no teto ainda cabe no espaço das Rodadas, lido das Configurações no início do envio, guardando `max_tokens` para a Rodada que conclui (§7, Crescimento do contexto); a que não cabe recebe `tool_call_limit`. A saída do Modelo conta pelo uso informado, porque o raciocínio volta inteiro mesmo com o texto vazio. Rodadas que passam do espaço fecham em `tool_limit` antes da próxima.
- Uma URL de Leitura sai na forma comparada (sem fragmento, em `https`), nunca como o Modelo a escreveu; repetidas viram uma.
- As chamadas da penúltima Rodada recebem `tool_call_limit` sem rede, para a última concluir com o que tem; a linha da chamada que o limite deixou sem resultado diz "não executada".
- A Leitura só sai para URLs elegíveis, calculadas no início da Rodada: uma Busca não autoriza uma Leitura que corre ao lado dela. URL recusada vira falha `not_eligible` sem rede.
- Depois de um 429 com `Retry-After`, as chamadas seguintes do turno recebem `tool_rate_limited` sem rede até a janela passar.
- `max_tokens` no meio de uma chamada fecha `complete` sem ela. Uma chamada quebrada com outro motivo é defeito do Provedor e fecha `failed`.
- O uso da Mensagem é a soma das Rodadas, e `firstTokenAt` é o primeiro delta de qualquer Parte.
- O Serviço é capturado no início do Fluxo, junto com o Provedor. Remover a Chave do Serviço roda em `flow.exclusive` e para a resposta em curso.

- `interrupted` preserva o texto recebido. Não é erro; a UI oferece "tentar de novo".
- `failed` preserva o texto recebido e guarda o `AppErrorInfo`.
- `finished` da Rodada final marca o fim lógico do Fluxo; o consumo termina quando o corpo fecha. A UI troca "parar" por "finalizando…" assim que chega o `stop_reason` (o `message_delta` que precede `finished`); parar ali não mudaria o estado final. O parser usa `try/finally` e chama `reader.cancel()` quando o consumidor para antes do fim; um `break` no `for await` não fecharia a conexão sozinho.
- **`finished` é terminal:** um erro ou abort depois dele não reabre a Mensagem; o estado final continua `complete`.
- Se o flush final falhar, a Mensagem continua `complete` em memória e `RunResult.persistError` carrega o erro; a UI avisa que a resposta não foi salva.
- **Tentar de novo substitui a última Mensagem do assistant** (mesmo id, Partes limpas, estado `streaming`, `createdAt` e `firstTokenAt` reiniciados para o ritmo ser da nova tentativa). É a única mutação permitida numa Mensagem. Sem isso, a Conversa acumularia duas respostas para o mesmo pedido.
- Enquanto há Fluxo, o composer fica desabilitado e só existe "parar". Isso elimina o caso de uma segunda Mensagem do user durante o Fluxo.
- O construtor de requisição funde Mensagens consecutivas do mesmo papel, descarta Mensagens sem texto nem Anexo e assistant nas pontas, nunca envia uma Mensagem `streaming` e exige que a última seja do user. Com Ferramentas no envio, a resposta antiga do mesmo Provedor volta desdobrada em assistant e user por Rodada, cortada na primeira chamada sem resultado e sem as Rodadas depois do último texto; fora disso, volta só o texto. Raciocínio de turnos anteriores não volta.

### Identidade e ordem

Cada Mensagem tem `seq`, um inteiro monotônico por Conversa, atribuído pelo app sob o lock da Conversa — duas abas não calculam o mesmo `seq`. O Dexie indexa `[conversationId+seq]`: a mesma chave lê as Mensagens de uma Conversa em ordem de `seq` e as apaga em cascata. `createdAt` serve para exibir, não para ordenar.

O Título nasce derivado da primeira Mensagem do user: os primeiros ~60 caracteres, cortados no limite de palavra. Quando a primeira resposta termina `complete`, o Modelo do Título o substitui por um nome curto, sem passar por cima de um Título que a pessoa renomeou (`titleSource`); em qualquer falha fica o derivado ([ADR 0011](adr/0011-generated-title.md)).

### Coordenação entre abas

Decisão e alternativas no [ADR 0006](adr/0006-web-locks-cross-tab.md). `app/locks.ts` define os nomes e a regra: escrever numa Conversa (enviar, tentar de novo, apagá-la) segura `toi:history` shared + `toi:conversation:<id>` exclusive; apagar Conversas e apagar tudo seguram `toi:history` exclusive. Nada espera: lock ocupado vira `flow_busy`.

Na abertura, `createToi` chama `recoverInterrupted`. Cada Mensagem `streaming` cuja Conversa tem o lock livre é relida sob os mesmos locks de quem escreve (`toi:history` shared e o lock da Conversa) e vira `interrupted`: o navegador solta o lock quando a página morre, então lock livre prova Fluxo sem dono. Histórico sendo apagado em outra aba também conta como ocupado.

### Cancelamento e durabilidade

Um `AbortController` por requisição em voo, mantido pelo `Flow`; `stop`, `exclusive` e a troca de Chave seguem o [ADR 0005](adr/0005-flow-as-module.md). A UI chama `flow.flush()` em `pagehide` e `visibilitychange`. Com flush a cada 300 ms, até 300 ms de tokens podem se perder num crash — aceito e documentado.

## 5. Provedor

Contratos em `src/ports/chat-provider.ts` e `src/domain/stream.ts`. O domínio só conhece seis Eventos: `started`, `part_started`, `delta`, `part_finished`, `usage` e `finished`.

Regras do adaptador:

- Eventos desconhecidos e `ping` são ignorados (a API pode adicionar tipos).
- `event: error` vira `AppError` tipado, não texto solto.
- **Uso é merge, não substituição:** `input_tokens`, `cache_creation_input_tokens` e `cache_read_input_tokens` vêm de `message_start`; `output_tokens` é substituído pelo último `message_delta` (cumulativo). Guardar "o último evento" perderia a entrada.
- O adaptador não decide UI, não grava nada e não retém histórico.

### Mapeamento Anthropic

| Domínio | Anthropic |
|---|---|
| `ChatMessage.parts` | `messages[].content` como lista de blocos |
| `Part` `text` | bloco `text` |
| `Part` `reasoning` | bloco `thinking` com `signature`, só dentro da resposta em curso |
| `Part` `redacted_reasoning` | bloco `redacted_thinking` |
| `Part` `tool_call` | bloco `tool_use` (`id`, `name`, `input`); o input chega em `input_json_delta` |
| `Part` `tool_result` | bloco `tool_result` (`tool_use_id`, `content`, `is_error`) numa Mensagem do user |
| `ChatRequest.tools` | `tools` (`name`, `description`, `input_schema`), só quando não está vazio |
| `Part` `file` de imagem | bloco `image`, `source` base64 em PNG ou JPEG |
| `Part` `file` de PDF | bloco `document`, `source` base64 `application/pdf`, nome em `title` |
| `Part` `file` de texto | bloco `document`, `source` `text`, nome em `title` |
| `ChatRequest.system` | `system`, só quando não é `null` |
| `ChatRequest.effort` | `output_config.effort`, sempre |
| `ChatRequest.reasoning` `off` | `thinking` que o Modelo aceita para desligar (`providers/anthropic/thinking.ts`, passado ao Protocolo); sem regra, nenhum |
| todo `ChatRequest` | `cache_control: { type: 'ephemeral' }` no topo, sempre: cache automático no TTL padrão, constante do Protocolo |
| `delta` de texto | `content_block_delta` → `text_delta` |
| `usage` | `message_start.usage` + `message_delta.usage` |
| `stopReason` | `message_delta.delta.stop_reason` |

A porta carrega Partes, não texto ([ADR 0003](adr/0003-message-as-parts-and-normalized-events.md)): os Anexos, o raciocínio e as Ferramentas entraram como Partes novas. Os Anexos vão na Mensagem do user antes do texto. `system` leva as Instruções no pedido de resposta, quando há, e a instrução própria no do Título, que não recebe as Instruções; é sempre campo próprio, nunca Mensagem. A porta não tem parâmetros de amostragem. O Esforço vai em todo envio e regula quanto o Modelo raciocina; `reasoning: 'off'`, só no pedido do Título, desliga o raciocínio onde o Modelo aceita; o raciocínio é gravado, mas não aparece (§1). As Ferramentas vão sem `eager_input_streaming`: os inputs são curtos, e sem ele a API valida cada parâmetro antes de emiti-lo. Todo pedido liga o cache de prompt; o que mantém o prefixo estável e as perdas aceitas estão no [ADR 0012](adr/0012-prompt-caching.md).

A Anthropic usa o Protocolo `anthropic-messages`; `anthropic-version` é do Protocolo, `x-api-key` e o header de acesso pelo navegador são do Provedor.

Requisição:

```
POST https://api.anthropic.com/v1/messages
x-api-key: <Chave>
anthropic-version: 2026-10-21
anthropic-dangerous-direct-browser-access: true
content-type: application/json

{ model, max_tokens, messages, stream: true, cache_control: { type: 'ephemeral' }, output_config: { effort }, system?, thinking?, tools? }
```

`max_tokens` é obrigatório. Default: `Math.min(8192, model.max_tokens ?? 8192)`.

Modelos:

```
GET https://api.anthropic.com/v1/models?limit=1000
```

Seguimos `has_more`/`last_id` por até 20 páginas e descartamos `lifecycle` diferente de `active` quando presente e os Modelos cujo `capabilities.effort` não aceita a escala inteira de Esforço: sem eles não há nível que falte a um Modelo nem envio sem Esforço. Guardamos `id`, `display_name`, `max_tokens`, `max_input_tokens` e `created_at`, mais o Provedor, a família e se o Modelo responde sem raciocinar (`reasoningOff`). A forma de cada página é validada: `data`, `has_more` e, quando há outra página, `last_id`; em cada Modelo, `id`, `display_name`, `created_at` e a árvore inteira de `capabilities.effort`. Fora do contrato, a listagem falha com resposta ilegível, sem nome, data ou lista inventados. `max_tokens` e `max_input_tokens` podem faltar e viram `null` (§7, Crescimento do contexto); presentes, são inteiros positivos. Nenhum ID de Modelo é fixo no código; a identidade de um Modelo inclui o Provedor ([ADR 0008](adr/0008-provider-and-protocol.md)).

O seletor não mostra a lista inteira. A família vem do Provedor; na Anthropic é o primeiro trecho só de letras do id depois de `claude` (`providers/anthropic/models.ts`). A escolha (`settings.modelPicks`) marca famílias, que acompanham a versão mais recente, e Modelos, que fixam uma versão, ambos com Provedor. O padrão são as famílias que cada Provedor sugere no descritor (Sonnet e Haiku na Anthropic), e Configurações lista todas as famílias para marcar outras. Se nenhuma marcação existe para a Chave, o Chat dá lugar ao estado explícito "nenhum modelo marcado existe para esta chave", com o atalho para escolher; não há troca silenciosa por outro Modelo. Um Modelo desmarcado que uma Conversa usa continua aparecendo nela. Falha ao ler ou gravar a escolha aparece em Configurações; gravar é otimista e volta ao estado salvo se falhar.

A lista fica em cache em `settings`, uma por Provedor (`toi.models()` junta as dos conectados), gravada por `connect` e por `toi.refreshModels()`; a abertura usa o cache e só lista na API quando ele não existe. Cache que não se lê é falha do armazenamento, não ausência: a abertura para no bloqueio da §9, sem listar na API. Se a listagem falhar, a UI mostra o erro com "tentar de novo" e "trocar Chave" — não há caminho silencioso. Se um refresh falha e existe cache, a lista anterior continua valendo e Configurações a marca como desatualizada, com o erro. `connect`, `connectService` e `refreshModels` exigem o `signal` de quem chama: o App segura um `AbortController` por carga da lista, e uma carga nova ou a conexão de uma Chave nova aborta a anterior, que não vira erro nem chega à tela. O cache não depende de quem chama abortar a tempo: entre a listagem e a gravação, `refreshModels` confere se a conexão que listou ainda é a do Provedor e, se a Chave trocou ou saiu no meio, rejeita como abort sem gravar, nem quando a resposta chega depois. Entrar em "trocar chave" e desistir ("manter a chave atual") deixa a carga em curso terminar.

### Primeira execução

1. Sem Chave: onboarding pede a Chave.
2. "Validar" = `GET /v1/models` com a Chave candidata. Não gastamos uma chamada de `messages`.
3. Sucesso: grava a Chave e o cache de Modelos; o default é o último Modelo usado ou, sem ele, o mais recente entre os que o seletor oferece, com o último Esforço usado ou, sem ele, o menor. A Conversa só é criada no primeiro envio.
4. Falha: erro tipado, sem gravar a Chave, com "tentar de novo".
5. Lista vazia: estado explícito "nenhum Modelo disponível para esta Chave", com retry.

`createToi` lê a Chave salva na abertura; `connect` valida com `listModels` e só então grava, de modo que uma Chave inválida não substitui a anterior.

### Serviço

Contrato em `src/ports/web-tools.ts`: `search`, `fetch` e `verify`. O adaptador não monta o texto que vai ao Modelo, não grava e não decide UI; `app/web-tools.ts` monta e corta o texto (15 mil caracteres por resultado, divididos entre as páginas de uma Leitura). Regras do adaptador da TinyFish (`adapters/services/tinyfish/tools.ts`):

- Busca: `GET https://api.search.tinyfish.ai?query=&language=`. Leitura: `POST https://api.fetch.tinyfish.ai { urls, format: 'markdown', per_url_timeout_ms }`. A Chave vai só em `X-API-Key`.
- Um timeout por chamada cobre cabeçalho e corpo: 20 s na Busca e 90 s na Leitura, com 25 s por URL. São provisórios até a prova com URLs lentas. Parar vence o timeout: o abort da pessoa passa intacto.
- O corpo é lido com teto (256 KB na Busca, 4 MB na Leitura, 16 KB num erro) e o JSON é validado na forma. Resposta cortada ou fora do contrato vira `tool_bad_response`, nunca resultado parcial.
- Fontes só `http(s)`. A falha de uma URL do lote vem em `failures` com um código do domínio; página sem texto conta como falha.
- `verify` é a Busca sem `query`: 400 prova a Chave sem gastar cota, e 401 a recusa (a confirmar com Chave real). `toi.connectService` valida antes de gravar, então uma Chave inválida não substitui a anterior.
- `toi.connected()` é só do Provedor; o Serviço tem `serviceConnected`. Uma Chave da TinyFish sozinha não pula o onboarding.

## 6. Persistência

IndexedDB via Dexie. O schema está em `src/adapters/storage/db.ts`: `conversations` indexa `id` e `updatedAt`; `messages` indexa `id`, `[conversationId+seq]` e `status`; `attachments` indexa `id` e `conversationId`; `settings` indexa `key`; `credentials` indexa `provider`, que guarda o dono da Chave: Provedor ou Serviço. O nome ficou porque trocar o keyPath na mesma versão faz toda gravação falhar no Dexie.

| Store | Conteúdo | Nunca contém |
|---|---|---|
| `conversations` | id, título e a origem dele, Provedor, Modelo e Esforço, timestamps | Mensagens |
| `messages` | id, conversationId, seq, papel, partes (de Anexo, só os metadados; de Ferramenta, o input, o texto entregue ao Modelo, as Fontes e as falhas), estado, timestamps (incluindo o primeiro token), Provedor, Modelo e Esforço, uso, stopReason, erro | Chave |
| `attachments` | id, conversationId e os bytes preparados (`Blob`) | Chave |
| `settings` | último Modelo e último Esforço, cache de Modelos por Provedor, Modelos do seletor, espaço das Rodadas, Modelo do Título, Instruções | Chave |
| `credentials` | Provedor ou Serviço → Chave | Qualquer dado de Conversa |

**Formato gravado:** o adaptador converte o domínio para registros escritos à mão (`adapters/storage/records.ts`) e de volta; como mudar a forma gravada está no [ADR 0007](adr/0007-explicit-persisted-formats.md).

**Erro serializável:** `Message.error` guarda `AppErrorInfo` — código, mensagem, detalhe e `retryAfterSeconds` —, um objeto plano. Structured clone não preserva protótipo de classe; ler do IndexedDB e usar `instanceof AppError` falharia.

**Escrita durante o Fluxo:** a Mensagem em memória é a fonte da verdade; o IndexedDB recebe flush conforme §4. Gravar por token é desperdício e trava a thread. A UI chama `flow.flush()` em `pagehide` e `visibilitychange` (`main.tsx`).

**Storage persistente:** `navigator.storage.persist()` na criação de uma Conversa. Configurações mostra se o navegador marcou o armazenamento como persistente e, se não, explica o risco e oferece pedir de novo. Safari/ITP pode descartar o armazenamento após ~7 dias sem interação, mesmo com o pedido aceito; isso é limitação visível, não nota de rodapé.

**Seleção de Conversa:** estado efêmero da UI, espelhado em `sessionStorage` para sobreviver a reload. Não é `settings`: duas abas podem ter seleções diferentes.

**Modelo e Esforço:** `conversation.provider` + `conversation.model` + `conversation.effort` são a fonte da verdade. Os seletores mudam a Conversa atual (`toi.changeModel`/`toi.changeEffort`, sem mexer em `updatedAt`); a resposta grava o Esforço pedido, como grava o Modelo. `settings.lastModel`, também com Provedor, e `settings.lastEffort` só definem o default de uma Conversa nova: são gravados a cada envio e a cada troca numa Conversa; no rascunho, a troca vale até o primeiro envio gravá-la. Falhar ao gravá-los não impede o envio. Sem `lastEffort`, a Conversa nova começa no menor Esforço. Ausência não é falha: quando a abertura não consegue lê-los ou ler o cache de Modelos, a tela fica no bloqueio da §9 em vez de seguir com o padrão.

**Instruções:** a linha `instructions` de `settings`, uma para todas as Conversas; o formato gravado e o que fica fora da Mensagem estão no [ADR 0013](adr/0013-instructions.md).

**Tema:** preferência visual desta máquina em `localStorage` (`toi:theme`), lida por `public/theme.js` antes do primeiro paint — IndexedDB é assíncrono e o tema piscaria. Não é dado de Conversa; "apagar tudo" também o limpa.

**Duas abas:** a seleção é independente; a barra lateral e a Conversa aberta observam o store (`watchConversations`/`watchMessages`, `liveQuery` no Dexie), então o que outra aba grava aparece sem recarregar — no ritmo do flush, a cada 300 ms; Mensagens de uma Conversa são escritas por uma aba por vez (§4). Metadados da Conversa, como Título e Modelo, seguem last write wins, e cada mudança é lida e gravada numa só transação (`updateConversation`): o fim de um Fluxo só toca `updatedAt` e não desfaz a troca de Modelo ou o Título que outra aba ou a pessoa mudou enquanto a resposta chegava. Sem merge de texto entre abas.

**Exportação:** `toi.exportHistory()` devolve um retrato do histórico no formato `toi.history` versão 1 (`app/export.ts`); a UI só transforma em arquivo. Lê apenas a porta de Conversas, então a Chave e as Configurações, Instruções incluídas, não têm caminho até o arquivo. Mensagem em Fluxo sai como `interrupted`. O Esforço da Conversa e da Mensagem entrou como campo novo, compatível, sem subir `version`; as Partes `file` (com os bytes em base64), `redacted_reasoning`, `tool_call` e `tool_result` também. O arquivo é um `Blob` montado por Mensagem, para o histórico não virar uma string só ([ADR 0009](adr/0009-attachments-inline-local.md)).

**Anexos:** os bytes preparados ficam em `attachments`, fora da Mensagem, para o `watchMessages` não reler megabytes a cada flush. A UI lê cada imagem quando ela chega perto da tela; PDF e texto só são lidos para baixar. Decisão e alternativas no ADR 0009.

**Apagar conversas** limpa `conversations`, `messages` e `attachments` numa transação, e apagar uma Conversa leva os Anexos dela; **apagar tudo** também remove Configurações e todas as Chaves, por composição no app ([ADR 0004](adr/0004-indexeddb-separate-credential-store.md)). Duas ações distintas em Configurações, ambas com confirmação explícita na própria linha.

## 7. Erros

Classificação por HTTP status; `error.type` reforça 429/529 e classifica os eventos de erro, pela mesma tabela (`protocols/anthropic-messages/error.ts`), em que tipo desconhecido é `unknown`. Corpo sem envelope de erro deixa o status decidir, com o `statusText` como detalhe. Texto só como fallback documentado.

| Código | Origem | Ação de UI |
|---|---|---|
| `invalid_credential` | 401 sem menção a CORS | Abrir Configurações |
| `browser_access_blocked` | 401 cujo corpo menciona CORS | Explicar e encerrar |
| `permission_denied` | 403 | Trocar Modelo |
| `model_unavailable` | 404 | Atualizar lista |
| `context_overflow` | 400 com detalhe de contexto (`prompt is too long`, `too many tokens`, `input length`) | Nova Conversa |
| `request_too_large` | 413 | Nova Conversa |
| `attachment_rejected` | 400 cujo detalhe fala de imagem, PDF, documento ou páginas, depois da checagem de contexto | Nova Conversa |
| `invalid_request` | 400 (outros) | Detalhe técnico |
| `rate_limited` | 429 ou `rate_limit_error` | Botão repetir, usando `retryAfterSeconds` |
| `overloaded` | 529 ou `overloaded_error` | Botão repetir |
| `api_error` | 5xx | Botão repetir |
| `unreachable` | `TypeError` no fetch, offline, CORS bloqueado ou Fluxo encerrado sem `finished` | Botão repetir |
| `not_connected` | `send`/`retry` sem Chave | Abrir onboarding |
| `flow_busy` | `send`/`retry`/apagar com Fluxo em voo ou limpeza em andamento, nesta ou em outra aba | Avisar; na própria aba o composer já fica desabilitado |
| `storage_failed` | IndexedDB recusou o flush final (`RunResult.persistError`), um Anexo do histórico sumiu do store ou as Instruções não foram lidas | Avisar que a resposta não foi salva; Anexo sumido ou Instruções ilegíveis falham a resposta sem rede |
| `storage_full` | `QuotaExceededError` ao gravar o envio (`startTurn`) | Avisar; texto e Anexos voltam ao composer |
| `unknown` | qualquer outro, inclusive chamada de Ferramenta quebrada pelo Provedor e resposta ilegível ou fora do contrato (stream, lista de Modelos) | Detalhe técnico |

Erros das Ferramentas ficam no `tool_result` da chamada e não fecham a Mensagem; só `tool_limit` fecha. A linha da chamada mostra a mensagem.

| Código | Origem | Ação de UI |
|---|---|---|
| `tool_invalid_credential` | 401 do Serviço | Link para Configurações |
| `tool_quota_exhausted` | 402 | Avisar que a cota diária volta à meia-noite UTC |
| `tool_rate_limited` | 429, ou janela de `Retry-After` ativa | Só a mensagem; o Modelo responde com o que tem |
| `tool_invalid_input` | input do Modelo fora do schema, ou 400/422 | Só a mensagem |
| `tool_forbidden` | 403 | Só a mensagem |
| `tool_url_not_eligible` | nenhuma URL da Leitura está na Conversa | Só a mensagem |
| `tool_call_limit` | chamada acima do teto do turno ou fora do espaço das Rodadas | Só a mensagem |
| `tool_unreachable` | rede, timeout, 404 ou 5xx | Só a mensagem |
| `tool_bad_response` | corpo grande, ilegível ou fora do contrato | Só a mensagem |
| `tool_limit` | 12ª Rodada ainda pede Ferramenta, ou as Rodadas passaram do espaço e o Modelo pede mais (fecha a Mensagem `failed`) | Tentar de novo |

As mensagens genéricas ficam em `src/domain/error.ts` (`appError`, `messageFor`, `truncatedError`); o adaptador sobrescreve as que nomeiam o Provedor (`api_error`, `unreachable`) e acrescenta detalhe. A UI nunca mostra o texto cru da API e a Chave nunca entra em mensagem de erro.

O navegador não distingue CORS de queda de rede: ambos chegam como `TypeError` sem status nem corpo. Por isso `unreachable` cobre as duas hipóteses, e `browser_access_blocked` só existe quando o corpo do 401 é legível — ou seja, quando o preflight passou.

Não há retry automático na v1: "repetir" é sempre ação da pessoa e substitui a última Mensagem do assistant.

### Crescimento do contexto

Toda Mensagem reenvia o histórico, com os Anexos e, com Ferramentas, os resultados antigos do mesmo Provedor. `build-request` estima tokens com `TokenEstimator` (heurística de ~3,5 caracteres por token; imagem por área, PDF por página, texto por byte). Primeiro, enquanto o histórico passa de um dos tetos da requisição (bytes, páginas, blocos ou 80% dos tokens), troca os Anexos e os resultados de Ferramenta dos turnos antigos, do mais antigo ao mais novo, por um marcador que diz que o conteúdo saiu do contexto (o de resultado mantém as Fontes); os tetos e o porquê estão no [ADR 0009](adr/0009-attachments-inline-local.md). Depois, acima de 80% de `max_input_tokens` (ou de 200 mil quando a API não informar), descarta turnos do meio preservando o primeiro turno e os turnos mais recentes que couberem, sempre incluindo o atual. O turno atual entra mesmo se sozinho estourar o orçamento; nesse caso a API recusa com `context_overflow` e a UI oferece uma Conversa nova. Com Ferramentas, o orçamento reserva antes o espaço das Rodadas, escolhido em Configurações (20 mil, 40 mil ou 80 mil tokens, sem passar da metade do orçamento); durante a resposta, a chamada cujo resultado no teto não cabe no que sobra recebe `tool_call_limit` sem rede ([ADR 0010](adr/0010-web-tools-via-tinyfish.md)). As Instruções também saem do orçamento antes de escolher o histórico e nunca são cortadas ([ADR 0013](adr/0013-instructions.md)). Quando há corte, a UI avisa o que saiu do contexto: turnos do meio, Anexos antigos, resultados antigos ou uma combinação. O marcador só existe na requisição; a Mensagem gravada não muda. Contagem exata via `/v1/messages/count_tokens` fica para a v1.1.

## 8. Segurança

**Modelo de ameaça.** Quem tem acesso ao perfil do navegador; código malicioso rodando na origem; dependência comprometida. Fora do escopo: a Anthropic (que recebe a Conversa por contrato), interceptação de rede (TLS) e acesso físico ao disco.

- A Chave fica no IndexedDB, nunca em URL, log, mensagem de erro ou exportação.
- CSP de produção em `public/_headers` (Cloudflare Workers Static Assets e equivalentes): `default-src` e `script-src` em `'self'`, `connect-src` só `'self'`, `https://api.anthropic.com`, `https://api.search.tinyfish.ai` e `https://api.fetch.tinyfish.ai`, `object-src`, `base-uri`, `frame-ancestors` e `form-action` em `'none'`. O header é a fonte da verdade. Se o host não permitir headers, o fallback `<meta http-equiv="Content-Security-Policy">` ignora `frame-ancestors`, `base-uri` e `form-action` — nesse caso o host está errado para este produto.
- HSTS em `public/_headers` (`max-age` de um ano, `includeSubDomains`): sem ele, o primeiro pedido por `http://` pode ser interceptado e servir uma página falsa que pede a Chave. Protege a partir da segunda visita; preload exigiria o header no domínio raiz.

- UI: sem `dangerouslySetInnerHTML`; Markdown sem `rehype-raw`; links externos com `rel="noopener noreferrer"` e `target="_blank"`.
- Sem script, fonte ou analytics de terceiro. Ícones (lucide) e fontes (Geist Mono e Lora via `@fontsource-variable`) vão no bundle. O único script fora do bundle é `public/theme.js`, servido pela própria origem.
- Markdown não carrega imagem: `![alt](url)` vira texto `[imagem: alt]`, porque buscaria um host de terceiro (e a CSP bloquearia).
- **Ferramentas são risco residual declarado** ([ADR 0010](adr/0010-web-tools-via-tinyfish.md)). A TinyFish recebe as consultas e URLs que o Modelo escolhe e pode treinar com elas. Uma página lida pode injetar instruções. A elegibilidade impede o Modelo de construir um destino novo ou acrescentar dado a uma URL, mas não cobre:
  - o texto da consulta da Busca, que pode levar o que está nas Instruções ([ADR 0013](adr/0013-instructions.md));
  - qual URL elegível ler e quando (cerca de 1 bit por chamada, visível ao dono da URL);
  - os redirects do destino;
  - uma URL sensível que a própria pessoa colou;
  - o link clicável que o Modelo escreve na resposta.
- **Supply chain é risco residual declarado:** uma dependência comprometida no bundle lê a Chave no IndexedDB. Lockfile, `npm ci`, número mínimo de dependências e revisão de diff reduzem a chance; não eliminam. `npm audit` detecta vulnerabilidade conhecida, não pacote malicioso novo.

## 9. Performance

Orçamento da v1. O que já é medível passa por `npm run size`; o resto são critérios de aceite da UI:

- **Bytes com gate:** `size-limit` mede o gzip de quatro arquivos do build de produção, cada um com uma folga pequena sobre o medido ao fixá-lo (os números estão em `.size-limit.json`), que absorve o bump de uma dependência, não uma dependência ou um recurso novo: crescer além dela vira decisão, e o limite sobe no mesmo PR que diz por quê. Cada entrada é um glob, e glob sem arquivo falha o gate, então um chunk renomeado não sai da conta em silêncio.
  - **JS inicial** (`index-*.js`): React, Dexie e o app; nada aparece antes dele.
  - **CSS** (`index-*.css`): bloqueia o render; inclui os `@font-face` (§11).
  - **Markdown** (`Markdown-*.js`): react-markdown e remark-gfm. Fica fora do inicial, mas é pré-carregado no idle em todo mount do Chat, então toda sessão baixa.
  - **Worker do Shiki** (`highlight.worker-*.js`): `shiki/core`, o engine de regex e os dois temas, baixados no primeiro bloco de código fechado. As gramáticas (`lang-*.js`) ficam fora: cada uma só baixa no primeiro uso da linguagem. O prefixo `lang-` também impede que, no macOS e no Windows, onde o glob do size-limit não diferencia maiúsculas, a gramática `markdown-*.js` entre na conta do `Markdown-*.js`.
  - Configurações e o preparo de Anexos ficam fora: só baixam quando a pessoa abre as Configurações ou anexa o primeiro arquivo.
- **Nenhuma long task > 50 ms durante um Fluxo de 500 deltas**, medido com `PerformanceObserver` numa página de teste, sem captura de trace do Playwright (os snapshots executam trabalho adicional na página); deltas são acumulados em buffer e aplicados ao React no máximo uma vez por frame (rAF).
- **Abertura sem piscar:** até ler o último Modelo, o último Esforço e os Modelos do seletor, e ter uma lista de Modelos (o cache ou, sem ele, a da API), o App mostra só a casca; o seletor nasceria no padrão e trocaria, e o bloqueio de "nenhum modelo marcado" piscaria. Se o armazenamento não entrega o último Modelo, o último Esforço ou o cache de Modelos, a tela de bloqueio oferece recarregar e abrir Configurações; ela só aparece depois que as três escolhas gravadas assentam, para Configurações não abrirem com os Modelos do seletor no padrão. Configurações não dependem do último Modelo nem do Esforço e abrem com a abertura falha: dali dá para trocar a Chave ou apagar tudo, que esvazia o armazenamento e remonta a tela: a abertura relê o armazenamento vazio e o bloqueio acaba. A leitura falha dos Modelos do seletor tem estado próprio, o padrão avisado em Configurações.
- Só a Mensagem em Fluxo re-renderiza: a lista é memoizada por id + estado, e os handlers que o App passa ao Chat têm identidade estável (`useCallback` com um ref do que leem), senão cada render do App invalidaria a memoização de todas as Mensagens. O scroll acompanha o fim apenas se a pessoa já estava no fim, e só ela o larga, rolando para cima: o evento de rolagem pode chegar com a lista já crescida, antes de o `ResizeObserver` acompanhar, então a distância ao fim sozinha não decide. Conversa que abre começa no fim.
- **Mensagens fora da tela:** cada uma tem `content-visibility: auto` (`ui/styles.css`) e, até aparecer pela primeira vez, reserva a altura média medida do papel; depois, a que teve. A média, acima da mediana, faz o fim encolher no caminho de "ir para o fim", e a rolagem suave para nele. Quando o fim anda mesmo assim, com Mensagens mais altas que a reserva, cada `scrollend` antes dele rola de novo, até a pessoa rolar por conta própria. Medido ao implementar, abrir uma Conversa de 600 Mensagens caiu de 63 para 3 ms de layout e de ~720 para ~560 ms de trabalho na main thread.
- **Markdown em Fluxo por blocos:** o texto é dividido em blocos de nível superior; blocos fechados são memoizados e só o último é reprocessado a cada frame. Reprocessar o texto inteiro por frame cresce com o tamanho da resposta e estoura o orçamento de long task.
- **Revelação do Fluxo:** o Provedor entrega em rajadas (token isolado, silêncio, um monte de deltas). A tela corre um quarto de segundo atrás da chegada, na velocidade em que o texto chega, e espalha cada rajada pelo silêncio anterior; fechada `complete`, o que falta aparece em até 400 ms. Aba oculta, movimento reduzido, `interrupted` e `failed` mostram tudo de uma vez. No bloco em curso, `remend` fecha o Markdown incompleto e cada palavra nova entra com fade de opacidade; o rodapé de uso e o copiar esperam o texto inteiro. O cursor só aparece com o Fluxo aberto e nada correndo (antes do primeiro token ou com o texto parado há 400 ms): enquanto o texto corre, a entrada das palavras já marca onde ele está.
- **Anexos fora do caminho inicial:** o preparo (`ui/attachments/prepare.ts`, com a contagem de páginas) é um chunk carregado no primeiro Anexo, e a imagem é reduzida por `OffscreenCanvas`. A leitura dos bytes no envio é assíncrona; medido ao implementar, enviar 20 MB não gerou long task, por isso o corpo da requisição continua uma string só.
- **Shiki num worker:** o highlight roda quando o bloco de código fecha, nunca a cada delta, num Web Worker de módulo (`ui/markdown/highlight.worker.ts`), onde a tokenização sai em série sem que um bloco de gramática já carregada espere outra baixar; a main thread manda o código e recebe só o texto e as cores de cada token. Até o worker responder, o bloco fica cru e com `aria-busy`. O worker é da própria origem, então o `script-src 'self'` da CSP (§8) basta. Ele leva `shiki/core` com o engine de regex em JavaScript (sem wasm), os dois temas usados e uma lista curada de linguagens com os nomes comuns do fence, cada gramática num chunk baixado no primeiro uso; fora da lista (`ui/markdown/languages.ts`) o código fica sem destaque e o worker nem nasce. Medido ao implementar, fechar um bloco de 200 linhas deixou de gerar uma long task de 133 ms, e um de 500, de 246 ms; com CPU 4×, o Fluxo de 500 deltas deixou de gerar uma de ~100 ms, e o que sobra num bloco grande é montar os `span` dos tokens (~100 ms). O deploy caiu de 338 para 91 arquivos e de 10,6 para 4,0 MB.

Implementação: `ui/use-messages.ts` junta deltas por frame; `ui/reveal.ts` decide quanto do texto está à vista e `ui/use-reveal.ts` roda um rAF por Mensagem enquanto há o que revelar; `ui/blocks.ts` divide o Markdown em blocos, cortando em linha em branco fora de bloco de código e sem separar continuação recuada de lista; `ui/Prose.tsx` memoiza cada bloco; `ui/markdown/Markdown.tsx` cura o bloco em curso e põe cada palavra num `span` (as chaves por posição do react-markdown mantêm as que já estavam, então só as novas animam). Markdown, Configurações e o preparo de Anexos são três chunks separados; o Shiki é um worker, com uma gramática por chunk. Cada deploy apaga os arquivos anteriores, então numa aba aberta antes dele o que ainda não baixou falha: o Markdown já vem pré-carregado no idle; o worker que não baixa deixa o código sem destaque até recarregar, sem ser pedido de novo, e a gramática que não baixa, só a linguagem dela; as Configurações mostram a tela de bloqueio com recarregar e o preparo recusa o arquivo como `not_loaded`. A long task é medida em `tests/e2e/performance.spec.ts` contra o build de produção, com os chunks lazy já carregados. Tempo de primeira interação não é orçamento: depende da rede e da máquina. O que controlamos é bytes, trabalho de main thread e número de re-renders.

## 10. Testes

| Fronteira | O que testa | Como |
|---|---|---|
| `domain` | título, famílias e marcação de Modelos, ritmo da resposta, tipo e dimensões pelos bytes, limites por Mensagem, forma comparável e elegibilidade de URL, aplicação de Eventos numa Rodada | Vitest puro |
| `adapters/http`, `protocols`, `providers` | parser SSE, mappers e classificação de erros HTTP | streams SSE montados no teste: texto, raciocínio com `signature`, `redacted_thinking`, `tool_use` com `input_json_delta`, `ping`, `error`, evento desconhecido, chunk cortado no meio de um caractere Unicode; casos principais de status; `retry-after` em segundos |
| `adapters/services` | Busca e Leitura da TinyFish: Chave no header, forma validada, Fontes só `http(s)`, falha por URL, status → erro tipado, teto de bytes, timeout, abort, `verify` | `fetch` falso; timeout com fake timers |
| `adapters/storage` | contrato da porta, schema, transação do envio, cascata de Anexos, `storage_full`, fronteira da Chave e Instruções apagadas com `null` | `MemoryStore` + Dexie com `fake-indexeddb` |
| `app/build-request` | fusão de papéis, descarte de Mensagens vazias, elisão de Anexos e de resultados por teto, truncamento, blocos da requisição, desdobramento de Rodadas, corte na chamada sem resultado, Partes de Ferramenta só do mesmo Provedor, Instruções em `system` e fora do orçamento | Vitest puro |
| `app/web-tools` | idioma da Busca, validação do input, URL não elegível sem rede, corte do resultado, teto de chamadas, espaço das Rodadas, espera depois de 429, abort esperando todas as chamadas | Serviço fake |
| `app/send-message` | enviar, abortar, falhar, retry, `finished` terminal, falha de persistência, instante do primeiro token, Anexos (bytes enviados, parar durante a leitura, Anexo sumido); Instruções (em `system`, as atuais ao tentar de novo, falha ao ler sem rede, parar durante a leitura, as mesmas em todas as Rodadas, URL só nelas sem Leitura); Rodadas: Busca e resposta com o raciocínio reenviado, Leitura recusada na mesma Rodada da Busca, erro do Serviço, `tool_limit`, `max_tokens` no meio da chamada, chamada quebrada, parar durante a Ferramenta | Provedor fake + Serviço fake + store em memória |
| `app/flow` | `stop` antes do Fluxo começar, `flush`, duas abas na mesma Conversa | Provedor fake + store em memória; duas instâncias de `Flow` com os mesmos locks simulam duas abas |
| `app/recover-interrupted` | lock livre, lock ocupado, Mensagem fechada entre listar e travar | clock fixo + store e locks em memória |
| `adapters/locks` | exclusive, shared e a soltura assíncrona | o mesmo contrato contra o `WebLocks` sobre o `navigator.locks` real do Node e contra o `MemoryLocks` dos testes, que o espelha |
| `app/export` | Fluxo em voo, Parte `file` com os bytes | store em memória |
| `app/toi` | validar antes de gravar (Provedor e Serviço), Chave anterior preservada, remover só a Chave do Serviço, apagar só a Conversa em voo, recusar envio durante apagar tudo, recusar limpeza com Fluxo em outra aba, exportar no formato `toi.history` sem a Chave, atualização de Modelos sem gravar o cache depois de a Chave trocar, Instruções normalizadas e recusadas acima do teto | fakes de store, credencial, settings e Provedor; um caso com Web Locks reais |
| `ui` (puro) | divisão em blocos, segmentos de texto e Ferramenta, a mescla entre store e Fluxo local, a revelação contra traces de rajada e a contagem de páginas de PDF | Vitest em Node (`tests/ui-pure.test.ts`, `tests/reveal.test.ts`, `tests/pdf-pages.test.ts`) |
| `ui/attachments` (preparo) | rotação EXIF sem metadados, redução, PNG ou JPEG, pixels demais, formato que o navegador não abre, texto UTF-8 | Vitest em modo browser no Chromium (`tests/ui/prepare.test.tsx`) |
| `ui` (componentes) | Markdown seguro (sem HTML cru, links, imagens, `javascript:`), highlight só em bloco fechado e pelos nomes do fence da lista curada, Markdown curado e palavras estáveis no bloco em curso, rodapé só com a resposta inteira e com a parte do cache, onboarding, enviar, parar com esc, shift+enter, linha da Busca com as Fontes, apagar com confirmação, abertura sem piscar, escolhas gravadas ou cache de Modelos ilegíveis, Configurações e "apagar tudo" com a abertura falha, cache ausente listado na API, trocar a Chave abortando a atualização da lista e manter a atual deixando-a terminar, anexar por clipe, colar e soltar, Anexo recusado, `storage_full` devolvendo o rascunho, Instruções (salvar, esc sem fechar com texto não salvo, teto, campo fechado sem leitura, rascunho mantido na falha) | Vitest em modo browser no Chromium (`tests/ui/`), com `createToi` real sobre stores em memória |
| E2E | enviar (com `cache_control` no corpo), parar e tentar de novo, recarregar no meio do Fluxo, duas abas, "ir para o fim" por Mensagens mais altas que a reserva, o fim acompanhado quando a rolagem chega com a lista já crescida, Conversa aberta no fim vindo do topo da anterior, orçamento de long task da §9, Anexos depois de recarregar e tentar de novo com eles, Instruções depois de recarregar no corpo da requisição; numa aba anterior ao deploy, Configurações, preparo de Anexo, worker do Shiki e gramática que não baixam | Playwright contra `vite preview` do build (`tests/e2e/`); só `fetch` para a Anthropic é simulado, o resto é o navegador real |

Regras: teste não usa `sleep`; debounce usa fake timers e instantes vêm de clock injetado. Teste de regressão fica vermelho no código anterior. Nada de teste que só confirme wiring.

## 11. Stack

Tudo da tabela está instalado. `npm run check` roda typecheck, Vitest (os projetos Node e browser num só processo), `vite build`, size-limit e Playwright, nessa ordem e sem repetir o typecheck do `npm run build`.

| Peça | Por quê |
|---|---|
| UI: React + Tailwind v4 | padrão dos projetos, sem biblioteca de componentes; tokens do blog em `ui/styles.css` |
| Fontes: Geist Mono e Lora (`@fontsource-variable`) | as do blog, servidas pela própria origem. Os `@font-face` são escritos em `ui/styles.css`, apontando para os `woff2` do pacote, só com `latin` (todo o pt-BR), `latin-ext` e o `symbols2` do Geist Mono (box-drawing em código); a Lora tem normal e itálico (`<em>` e citação). O CSS do pacote declararia 20 faces, com cirílico, vietnamita e os símbolos da Lora, no CSS que bloqueia o render. Medido ao implementar: o CSS caiu 1,4 KB gzip e o deploy, 13 arquivos e 245 KB |
| Estado: hooks sobre `Toi` | o app já é a fonte da verdade; uma store de UI duplicaria o estado do Fluxo. `toi.watch*` entrega o que está gravado (também por outra aba) e `toi.subscribe` o Fluxo desta aba antes do flush; `ui/merge.ts` decide qual vale |
| Coordenação entre abas: Web Locks | o navegador solta o lock quando a página morre; sem dependência ([ADR 0006](adr/0006-web-locks-cross-tab.md)) |
| Persistência: Dexie | schema e índices declarados no IndexedDB |
| Markdown: react-markdown + remark-gfm | sem HTML cru |
| Código: Shiki num Web Worker (`shiki/core` + engine JS, linguagens curadas) | highlight correto sem wasm, sem peso no carregamento inicial e sem tokenizar na main thread |
| Ícones: lucide-react | já usado nos projetos |
| Testes: Vitest | núcleo em Node; `fake-indexeddb` cobre o adaptador Dexie e o `navigator.locks` do Node cobre o adaptador de locks |
| Testes de UI: Vitest browser mode + Playwright | jsdom não mede long task, rAF nem IndexedDB real; o orçamento da §9 só vale medido em navegador |
| Gate: size-limit | o orçamento da §9 precisa falhar `npm run size`/`npm run check` |

Sem router na v1: uma tela, Conversa selecionada em estado da UI. Sem SDK de IA: o adaptador é pequeno e o contrato que queremos é o do domínio.

Publicação, domínio e CI/CD estão em [deployment.md](deployment.md).

## 12. Depois da v1

1. Importar JSON no formato da exportação (`toi.history`).
2. Mostrar o raciocínio gravado.
3. Parâmetros (temperatura, `max_tokens`).
4. Contagem exata de tokens via `/v1/messages/count_tokens`.
5. Busca no histórico e no texto.
6. Segundo Provedor (OpenAI, depois OpenCode Go e Google), sobre a separação do [ADR 0008](adr/0008-provider-and-protocol.md).
7. PWA e uso offline do shell.
8. Criptografia da Chave com passphrase, se o modelo de ameaça mudar.
9. Medir o peso de `tool_result` nas Mensagens e se o padrão do espaço das Rodadas cobre as pesquisas reais ([ADR 0010](adr/0010-web-tools-via-tinyfish.md)).
