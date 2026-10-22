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
- tokens de entrada e saída, tempo até o texto aparecer e tokens por segundo por Mensagem.

**Fora da v1:** conta, sincronização, compartilhamento, i18n, ferramentas, busca na web, branching e os itens do roadmap (§12).

**Raciocínio fica fora da v1 de propósito.** Blocos `thinking` exigem `signature` preservada e devolvida verbatim nas requisições seguintes; modelá-los agora obrigaria a guardar um campo opaco e a tratar uma exceção no envio. O schema de Partes já comporta o tipo, mas nenhum `thinking` é pedido nem persistido até essa decisão existir.

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
    storage/     # db, records, conversations, credentials, settings
    locks/       # web (navigator.locks)
    tokens/      # heuristic
  app/           # flow, toi, locks, connect, conversations, erase, export, send-message, build-request; sem React
  ui/            # React + Tailwind: App, Onboarding, Sidebar, Chat, Prose, Settings (lazy), markdown/ (lazy),
                 # attachments/ (rascunho, chips e diálogo; o preparo é lazy)
  main.tsx       # composition root: injeta os adaptadores concretos em `createToi`
```

`Flow` (`app/flow.ts`) é o módulo do Fluxo em voo e `Toi` (`app/toi.ts`) é a fachada do app; a UI depende só dos dois. Responsabilidades e porquê em [ADR 0005](adr/0005-flow-as-module.md).

**Regra de dependência:** `ui → app → ports ← adapters`; todos podem importar `domain`; `domain` não importa ninguém. `app` não importa `adapters` e recebe as implementações por injeção. `main.tsx` é o composition root e injeta as implementações concretas; cada Provedor entra em `Toi` como um `ProviderAdapter` (`info` + `create(key)`) na lista `providers`. Provedor e Protocolo são papéis separados dentro de `adapters` ([ADR 0008](adr/0008-provider-and-protocol.md)).

As portas existem por fronteiras reais: `ChatProvider` isola o HTTP de terceiro e permite um segundo Provedor, e `ProviderInfo` é tudo que a UI sabe dele; o storage permite trocar IndexedDB ou usar memória em teste; `Locks` coordena abas por Web Locks; `TokenEstimator` permite substituir a heurística pela contagem exata sem tocar no domínio; `SettingsStore` guarda o cache de Modelos, o último Modelo e o último Esforço e quais Modelos o seletor oferece.

## 4. Ciclo de uma Mensagem

`Flow.send` (o caso de uso `startSendMessage`):

1. segura os locks da Conversa (§4, Coordenação entre abas) até o passo 7; sem eles, `flow_busy`;
2. grava numa transação (`startTurn`) a Mensagem do user (`complete`), a do assistant (`streaming`) e os bytes dos Anexos;
3. normaliza e seleciona o histórico, busca no store só os Anexos que ficaram e monta o `ChatRequest` com os Blobs, que o adapter lê ao montar o corpo (`build-request`); parar durante a busca fecha em `interrupted` sem chamar o Provedor;
4. consome `provider.stream(request, signal)`;
5. para cada Evento aplicado, atualiza a Parte e agenda o flush (300 ms);
6. fecha em `complete`, `interrupted` ou `failed`;
7. devolve `RunResult` e solta os locks; falha de persistência vai em `persistError`, sem reabrir a Mensagem.

```
streaming ── finished ──► complete
          ├─ abort ─────► interrupted
          └─ erro ──────► failed
```

- `interrupted` preserva o texto recebido. Não é erro; a UI oferece "tentar de novo".
- `failed` preserva o texto recebido e guarda o `AppErrorInfo`.
- `finished` marca o fim lógico do Fluxo; o consumo termina quando o corpo fecha. A UI troca "parar" por "finalizando…" assim que chega o `stop_reason` (o `message_delta` que precede `finished`); parar ali não mudaria o estado final. O parser usa `try/finally` e chama `reader.cancel()` quando o consumidor para antes do fim; um `break` no `for await` não fecharia a conexão sozinho.
- **`finished` é terminal:** um erro ou abort depois dele não reabre a Mensagem; o estado final continua `complete`.
- Se o flush final falhar, a Mensagem continua `complete` em memória e `RunResult.persistError` carrega o erro; a UI avisa que a resposta não foi salva.
- **Tentar de novo substitui a última Mensagem do assistant** (mesmo id, Partes limpas, estado `streaming`, `createdAt` e `firstTokenAt` reiniciados para o ritmo ser da nova tentativa). É a única mutação permitida numa Mensagem. Sem isso, a Conversa acumularia duas respostas para o mesmo pedido.
- Enquanto há Fluxo, o composer fica desabilitado e só existe "parar". Isso elimina o caso de uma segunda Mensagem do user durante o Fluxo.
- O construtor de requisição funde Mensagens consecutivas do mesmo papel, descarta Mensagens sem texto nem Anexo e assistant nas pontas, nunca envia uma Mensagem `streaming` e exige que a última seja do user.

### Identidade e ordem

Cada Mensagem tem `seq`, um inteiro monotônico por Conversa, atribuído pelo app sob o lock da Conversa — duas abas não calculam o mesmo `seq`. O Dexie indexa `conversationId` e `[conversationId+seq]`; a leitura ordena por `seq`. `createdAt` serve para exibir, não para ordenar.

O Título é derivado na primeira Mensagem do user: os primeiros ~60 caracteres, cortados no limite de palavra. Nenhuma chamada extra ao Modelo só para nomear.

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
| `Part` `reasoning` | bloco `thinking` com `signature` (o `build-request` da v1 não envia) |
| `Part` `file` de imagem | bloco `image`, `source` base64 em PNG ou JPEG |
| `Part` `file` de PDF | bloco `document`, `source` base64 `application/pdf`, nome em `title` |
| `Part` `file` de texto | bloco `document`, `source` `text`, nome em `title` |
| `ChatRequest.system` | `system`, só quando definido |
| `ChatRequest.effort` | `output_config.effort`, sempre |
| `delta` de texto | `content_block_delta` → `text_delta` |
| `usage` | `message_start.usage` + `message_delta.usage` |
| `stopReason` | `message_delta.delta.stop_reason` |

A porta carrega Partes, não texto ([ADR 0003](adr/0003-message-as-parts-and-normalized-events.md)): os Anexos entraram como Partes novas, e raciocínio e ferramentas entram do mesmo jeito. Os Anexos vão na Mensagem do user antes do texto. `system` existe na porta, mas a v1 não o preenche; system prompt é sempre campo próprio, nunca Mensagem. A porta não tem parâmetros de amostragem. O Esforço vai em todo envio: regula quanto o Modelo raciocina, mas o raciocínio continua oculto — nenhum `thinking` é pedido nem persistido (§1).

A Anthropic usa o Protocolo `anthropic-messages`; `anthropic-version` é do Protocolo, `x-api-key` e o header de acesso pelo navegador são do Provedor.

Requisição:

```
POST https://api.anthropic.com/v1/messages
x-api-key: <Chave>
anthropic-version: 2026-10-21
anthropic-dangerous-direct-browser-access: true
content-type: application/json

{ model, max_tokens, messages, stream: true, output_config: { effort }, system? }
```

`max_tokens` é obrigatório. Default: `Math.min(8192, model.max_tokens ?? 8192)`.

Modelos:

```
GET https://api.anthropic.com/v1/models?limit=1000
```

Seguimos `has_more`/`last_id` por até 20 páginas e descartamos `lifecycle` diferente de `active` quando presente e os Modelos cujo `capabilities.effort` não aceita a escala inteira de Esforço: sem eles não há nível que falte a um Modelo nem envio sem Esforço. Guardamos `id`, `display_name`, `max_tokens`, `max_input_tokens` e `created_at`, mais o Provedor e a família. Nenhum ID de Modelo é fixo no código; a identidade de um Modelo inclui o Provedor ([ADR 0008](adr/0008-provider-and-protocol.md)).

O seletor não mostra a lista inteira. A família vem do Provedor; na Anthropic é o primeiro trecho só de letras do id depois de `claude` (`providers/anthropic/models.ts`). A escolha (`settings.modelPicks`) marca famílias, que acompanham a versão mais recente, e Modelos, que fixam uma versão, ambos com Provedor. O padrão são as famílias que cada Provedor sugere no descritor (Sonnet e Haiku na Anthropic), e Configurações lista todas as famílias para marcar outras. Se nenhuma marcação existe para a Chave, o Chat dá lugar ao estado explícito "nenhum modelo marcado existe para esta chave", com o atalho para escolher; não há troca silenciosa por outro Modelo. Um Modelo desmarcado que uma Conversa usa continua aparecendo nela. Falha ao ler ou gravar a escolha aparece em Configurações; gravar é otimista e volta ao estado salvo se falhar.

A lista fica em cache em `settings`, uma por Provedor (`toi.models()` junta as dos conectados), gravada por `connect` e por `toi.refreshModels()`; a abertura usa o cache e só lista na API quando ele não existe. Se a listagem falhar, a UI mostra o erro com "tentar de novo" e "trocar Chave" — não há caminho silencioso. Se um refresh falha e existe cache, a lista anterior continua valendo e Configurações a marca como desatualizada, com o erro.

### Primeira execução

1. Sem Chave: onboarding pede a Chave.
2. "Validar" = `GET /v1/models` com a Chave candidata. Não gastamos uma chamada de `messages`.
3. Sucesso: grava a Chave e o cache de Modelos; o default é o último Modelo usado ou, sem ele, o mais recente entre os que o seletor oferece, com o último Esforço usado ou, sem ele, o menor. A Conversa só é criada no primeiro envio.
4. Falha: erro tipado, sem gravar a Chave, com "tentar de novo".
5. Lista vazia: estado explícito "nenhum Modelo disponível para esta Chave", com retry.

`createToi` lê a Chave salva na abertura; `connect` valida com `listModels` e só então grava, de modo que uma Chave inválida não substitui a anterior.

## 6. Persistência

IndexedDB via Dexie. O schema está em `src/adapters/storage/db.ts`: `conversations` indexa `id` e `updatedAt`; `messages` indexa `id`, `conversationId`, `[conversationId+seq]` e `status`; `attachments` indexa `id` e `conversationId`; `settings` indexa `key`; `credentials` indexa `provider`.

| Store | Conteúdo | Nunca contém |
|---|---|---|
| `conversations` | id, título, Provedor, Modelo e Esforço, timestamps | Mensagens |
| `messages` | id, conversationId, seq, papel, partes (de Anexo, só os metadados), estado, timestamps (incluindo o primeiro token), Provedor, Modelo e Esforço, uso, stopReason, erro | Chave |
| `attachments` | id, conversationId e os bytes preparados (`Blob`) | Chave |
| `settings` | último Modelo e último Esforço, cache de Modelos por Provedor, Modelos do seletor | Chave |
| `credentials` | Provedor → Chave | Qualquer dado de Conversa |

**Formato gravado:** o adaptador converte o domínio para registros escritos à mão (`adapters/storage/records.ts`) e de volta; como mudar a forma gravada está no [ADR 0007](adr/0007-explicit-persisted-formats.md).

**Erro serializável:** `Message.error` guarda `AppErrorInfo` — código, mensagem, detalhe e `retryAfterSeconds` —, um objeto plano. Structured clone não preserva protótipo de classe; ler do IndexedDB e usar `instanceof AppError` falharia.

**Escrita durante o Fluxo:** a Mensagem em memória é a fonte da verdade; o IndexedDB recebe flush conforme §4. Gravar por token é desperdício e trava a thread. A UI chama `flow.flush()` em `pagehide` e `visibilitychange` (`main.tsx`).

**Storage persistente:** `navigator.storage.persist()` na criação de uma Conversa. Configurações mostra se o navegador marcou o armazenamento como persistente e, se não, explica o risco e oferece pedir de novo. Safari/ITP pode descartar o armazenamento após ~7 dias sem interação, mesmo com o pedido aceito; isso é limitação visível, não nota de rodapé.

**Seleção de Conversa:** estado efêmero da UI, espelhado em `sessionStorage` para sobreviver a reload. Não é `settings`: duas abas podem ter seleções diferentes.

**Modelo e Esforço:** `conversation.provider` + `conversation.model` + `conversation.effort` são a fonte da verdade. Os seletores mudam a Conversa atual (`toi.changeModel`/`toi.changeEffort`, sem mexer em `updatedAt`); a resposta grava o Esforço pedido, como grava o Modelo. `settings.lastModel`, também com Provedor, e `settings.lastEffort` só definem o default de uma Conversa nova: são gravados a cada envio e a cada troca numa Conversa; no rascunho, a troca vale até o primeiro envio gravá-la. Falhar ao gravá-los não impede o envio. Sem `lastEffort`, a Conversa nova começa no menor Esforço.

**Tema:** preferência visual desta máquina em `localStorage` (`toi:theme`), lida por `public/theme.js` antes do primeiro paint — IndexedDB é assíncrono e o tema piscaria. Não é dado de Conversa; "apagar tudo" também o limpa.

**Duas abas:** a seleção é independente; a barra lateral e a Conversa aberta observam o store (`watchConversations`/`watchMessages`, `liveQuery` no Dexie), então o que outra aba grava aparece sem recarregar — no ritmo do flush, a cada 300 ms; Mensagens de uma Conversa são escritas por uma aba por vez (§4). Metadados da Conversa, como Título e Modelo, seguem last write wins, e cada mudança é lida e gravada numa só transação (`updateConversation`): o fim de um Fluxo só toca `updatedAt` e não desfaz a troca de Modelo ou o Título que outra aba ou a pessoa mudou enquanto a resposta chegava. Sem merge de texto entre abas.

**Exportação:** `toi.exportHistory()` devolve um retrato do histórico no formato `toi.history` versão 1 (`app/export.ts`); a UI só transforma em arquivo. Lê apenas a porta de Conversas, então a Chave não tem caminho até o arquivo. Mensagem em Fluxo sai como `interrupted`. O Esforço da Conversa e da Mensagem entrou como campo novo, compatível, sem subir `version`; a Parte `file` também, com os bytes em base64. O arquivo é um `Blob` montado por Mensagem, para o histórico não virar uma string só ([ADR 0009](adr/0009-attachments-inline-local.md)).

**Anexos:** os bytes preparados ficam em `attachments`, fora da Mensagem, para o `watchMessages` não reler megabytes a cada flush. A UI lê cada imagem quando ela chega perto da tela; PDF e texto só são lidos para baixar. Decisão e alternativas no ADR 0009.

**Apagar conversas** limpa `conversations`, `messages` e `attachments` numa transação, e apagar uma Conversa leva os Anexos dela; **apagar tudo** também remove Configurações e todas as Chaves, por composição no app ([ADR 0004](adr/0004-indexeddb-separate-credential-store.md)). Duas ações distintas em Configurações, ambas com confirmação explícita na própria linha.

## 7. Erros

Classificação por HTTP status; `error.type` reforça 429/529 e eventos de erro. Texto só como fallback documentado.

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
| `aborted` | `AbortError` | Estado `interrupted` |
| `not_connected` | `send`/`retry` sem Chave | Abrir onboarding |
| `flow_busy` | `send`/`retry`/apagar com Fluxo em voo ou limpeza em andamento, nesta ou em outra aba | Avisar; na própria aba o composer já fica desabilitado |
| `storage_failed` | IndexedDB recusou o flush final (`RunResult.persistError`) ou um Anexo do histórico sumiu do store | Avisar que a resposta não foi salva; Anexo sumido falha a resposta |
| `storage_full` | `QuotaExceededError` ao gravar o envio (`startTurn`) | Avisar; texto e Anexos voltam ao composer |
| `unknown` | qualquer outro | Detalhe técnico |

As mensagens genéricas ficam em `src/domain/error.ts` (`appError`, `messageFor`, `truncatedError`); o adaptador sobrescreve as que nomeiam o Provedor (`api_error`, `unreachable`) e acrescenta detalhe. A UI nunca mostra o texto cru da API e a Chave nunca entra em mensagem de erro.

O navegador não distingue CORS de queda de rede: ambos chegam como `TypeError` sem status nem corpo. Por isso `unreachable` cobre as duas hipóteses, e `browser_access_blocked` só existe quando o corpo do 401 é legível — ou seja, quando o preflight passou.

Não há retry automático na v1: "repetir" é sempre ação da pessoa e substitui a última Mensagem do assistant.

### Crescimento do contexto

Toda Mensagem reenvia o histórico, com os Anexos. `build-request` estima tokens com `TokenEstimator` (heurística de ~3,5 caracteres por token; imagem por área, PDF por página, texto por byte). Primeiro, enquanto o histórico passa de um dos tetos da requisição (bytes, páginas, blocos ou 80% dos tokens), troca os Anexos dos turnos antigos, do mais antigo ao mais novo, por um marcador que diz que o arquivo saiu do contexto; os tetos e o porquê estão no [ADR 0009](adr/0009-attachments-inline-local.md). Depois, acima de 80% de `max_input_tokens` (ou de 200 mil quando a API não informar), descarta turnos do meio preservando o primeiro turno e os turnos mais recentes que couberem, sempre incluindo o atual. O turno atual entra mesmo se sozinho estourar o orçamento; nesse caso a API recusa com `context_overflow` e a UI oferece uma Conversa nova. Quando há corte, a UI avisa o que saiu do contexto: turnos do meio, Anexos antigos ou os dois. O marcador só existe na requisição; a Mensagem gravada não muda. Contagem exata via `/v1/messages/count_tokens` fica para a v1.1.

## 8. Segurança

**Modelo de ameaça.** Quem tem acesso ao perfil do navegador; código malicioso rodando na origem; dependência comprometida. Fora do escopo: a Anthropic (que recebe a Conversa por contrato), interceptação de rede (TLS) e acesso físico ao disco.

- A Chave fica no IndexedDB, nunca em URL, log, mensagem de erro ou exportação.
- CSP de produção em `public/_headers` (Cloudflare Workers Static Assets e equivalentes): `default-src` e `script-src` em `'self'`, `connect-src` só `'self'` e `https://api.anthropic.com`, `object-src`, `base-uri`, `frame-ancestors` e `form-action` em `'none'`. O header é a fonte da verdade. Se o host não permitir headers, o fallback `<meta http-equiv="Content-Security-Policy">` ignora `frame-ancestors`, `base-uri` e `form-action` — nesse caso o host está errado para este produto.

- UI: sem `dangerouslySetInnerHTML`; Markdown sem `rehype-raw`; links externos com `rel="noopener noreferrer"` e `target="_blank"`.
- Sem script, fonte ou analytics de terceiro. Ícones (lucide) e fontes (Geist Mono e Lora via `@fontsource-variable`) vão no bundle. O único script fora do bundle é `public/theme.js`, servido pela própria origem.
- Markdown não carrega imagem: `![alt](url)` vira texto `[imagem: alt]`, porque buscaria um host de terceiro (e a CSP bloquearia).
- **Supply chain é risco residual declarado:** uma dependência comprometida no bundle lê a Chave no IndexedDB. Lockfile, `npm ci`, número mínimo de dependências e revisão de diff reduzem a chance; não eliminam. `npm audit` detecta vulnerabilidade conhecida, não pacote malicioso novo.

## 9. Performance

Orçamento da v1. O que já é medível passa por `npm run size`; o resto são critérios de aceite da UI:

- **JS inicial ≤ 150 KB gzip**, medido com `size-limit` no build de produção; o gate local falha acima. Markdown, Shiki e o painel de Configurações ficam em chunks lazy e não entram na conta.
- **Nenhuma long task > 50 ms durante um Fluxo de 500 deltas**, medido com `PerformanceObserver` numa página de teste; deltas são acumulados em buffer e aplicados ao React no máximo uma vez por frame (rAF).
- Só a Mensagem em Fluxo re-renderiza; a lista é memoizada por id + estado; o scroll acompanha o fim apenas se a pessoa já estava no fim.
- **Markdown em Fluxo por blocos:** o texto é dividido em blocos de nível superior; blocos fechados são memoizados e só o último é reprocessado a cada frame. Reprocessar o texto inteiro por frame cresce com o tamanho da resposta e estoura o orçamento de long task.
- **Revelação do Fluxo:** o Provedor entrega em rajadas (token isolado, silêncio, um monte de deltas). A tela corre um quarto de segundo atrás da chegada, na velocidade em que o texto chega, e espalha cada rajada pelo silêncio anterior; fechada `complete`, o que falta aparece em até 400 ms. Aba oculta, movimento reduzido, `interrupted` e `failed` mostram tudo de uma vez. No bloco em curso, `remend` fecha o Markdown incompleto e cada palavra nova entra com fade de opacidade; o rodapé de uso e o copiar esperam o texto inteiro. O cursor só aparece com o Fluxo aberto e nada correndo (antes do primeiro token ou com o texto parado há 400 ms): enquanto o texto corre, a entrada das palavras já marca onde ele está.
- **Anexos fora do caminho inicial:** o preparo (`ui/attachments/prepare.ts`, com a contagem de páginas) é um chunk carregado no primeiro Anexo, e a imagem é reduzida por `OffscreenCanvas`. A leitura dos bytes no envio é assíncrona; medido ao implementar, enviar 20 MB não gerou long task, por isso o corpo da requisição continua uma string só.
- **Shiki enxuto:** `shiki/core` com o engine de regex em JavaScript (sem wasm) e grammars carregadas sob demanda; o highlight roda quando o bloco de código fecha, nunca a cada delta.

Implementação: `ui/use-messages.ts` junta deltas por frame; `ui/reveal.ts` decide quanto do texto está à vista e `ui/use-reveal.ts` roda um rAF por Mensagem enquanto há o que revelar; `ui/blocks.ts` divide o Markdown em blocos, cortando em linha em branco fora de bloco de código e sem separar continuação recuada de lista; `ui/Prose.tsx` memoiza cada bloco; `ui/markdown/Markdown.tsx` cura o bloco em curso e põe cada palavra num `span` (as chaves por posição do react-markdown mantêm as que já estavam, então só as novas animam). Markdown, Shiki, Configurações e o preparo de Anexos são quatro chunks separados. A long task é medida em `tests/e2e/performance.spec.ts` contra o build de produção, com os chunks lazy já carregados. Tempo de primeira interação não é orçamento: depende da rede e da máquina. O que controlamos é bytes, trabalho de main thread e número de re-renders.

## 10. Testes

| Fronteira | O que testa | Como |
|---|---|---|
| `domain` | título, famílias e marcação de Modelos, ritmo da resposta, tipo e dimensões pelos bytes, limites por Mensagem | Vitest puro |
| `adapters/http`, `protocols`, `providers` | parser SSE, mappers e classificação de erros HTTP | streams SSE montados no teste: texto, `ping`, `error`, evento desconhecido, chunk cortado no meio de um caractere Unicode; casos principais de status; `retry-after` em segundos |
| `adapters/storage` | contrato da porta, schema, transação do envio, cascata de Anexos, `storage_full` e fronteira da Chave | `MemoryStore` + Dexie com `fake-indexeddb` |
| `app/build-request` | fusão de papéis, descarte de Mensagens vazias, elisão de Anexos por teto, truncamento, blocos da requisição | Vitest puro |
| `app/send-message` | enviar, abortar, falhar, retry, `finished` terminal, falha de persistência, instante do primeiro token, Anexos (bytes enviados, parar durante a leitura, Anexo sumido) | Provedor fake + store em memória |
| `app/flow` | `stop` antes do Fluxo começar, `flush`, duas abas na mesma Conversa | Provedor fake + store em memória; duas instâncias de `Flow` com os mesmos locks simulam duas abas |
| `app/recover-interrupted` | lock livre, lock ocupado, Mensagem fechada entre listar e travar | clock fixo + store e locks em memória |
| `adapters/locks` | exclusive, shared e a soltura assíncrona | o mesmo contrato contra o `WebLocks` sobre o `navigator.locks` real do Node e contra o `MemoryLocks` dos testes, que o espelha |
| `app/export` | Fluxo em voo, Parte `file` com os bytes | store em memória |
| `app/toi`/`connect` | validar antes de gravar, Chave anterior preservada, apagar só a Conversa em voo, recusar envio durante apagar tudo, recusar limpeza com Fluxo em outra aba, exportar no formato `toi.history` sem a Chave | fakes de store, credencial, settings e Provedor; um caso com Web Locks reais |
| `ui` (puro) | divisão em blocos, a mescla entre store e Fluxo local, a revelação contra traces de rajada e a contagem de páginas de PDF | Vitest em Node (`tests/ui-pure.test.ts`, `tests/reveal.test.ts`, `tests/pdf-pages.test.ts`) |
| `ui/attachments` (preparo) | rotação EXIF sem metadados, redução, PNG ou JPEG, pixels demais, formato que o navegador não abre, texto UTF-8 | Vitest em modo browser no Chromium (`tests/ui/prepare.test.tsx`) |
| `ui` (componentes) | Markdown seguro (sem HTML cru, links, imagens, `javascript:`), highlight só em bloco fechado, Markdown curado e palavras estáveis no bloco em curso, rodapé só com a resposta inteira, onboarding, enviar, parar com esc, shift+enter, apagar com confirmação, anexar por clipe, colar e soltar, Anexo recusado, `storage_full` devolvendo o rascunho | Vitest em modo browser no Chromium (`tests/ui/`), com `createToi` real sobre stores em memória |
| E2E | enviar, parar e tentar de novo, recarregar no meio do Fluxo, duas abas, orçamento de long task da §9, Anexos depois de recarregar e tentar de novo com eles | Playwright contra `vite preview` do build (`tests/e2e/`); só `fetch` para a Anthropic é simulado, o resto é o navegador real |

Regras: teste não usa `sleep`; debounce usa fake timers e instantes vêm de clock injetado. Teste de regressão fica vermelho no código anterior. Nada de teste que só confirme wiring.

## 11. Stack

Tudo da tabela está instalado. `npm run check` roda typecheck, Vitest (Node e browser), build, size-limit e Playwright.

| Peça | Por quê |
|---|---|
| UI: React + Tailwind v4 | padrão dos projetos, sem biblioteca de componentes; tokens do blog em `ui/styles.css` |
| Fontes: Geist Mono e Lora (`@fontsource-variable`) | as do blog, servidas pela própria origem |
| Estado: hooks sobre `Toi` | o app já é a fonte da verdade; uma store de UI duplicaria o estado do Fluxo. `toi.watch*` entrega o que está gravado (também por outra aba) e `toi.subscribe` o Fluxo desta aba antes do flush; `ui/merge.ts` decide qual vale |
| Coordenação entre abas: Web Locks | o navegador solta o lock quando a página morre; sem dependência ([ADR 0006](adr/0006-web-locks-cross-tab.md)) |
| Persistência: Dexie | schema e índices declarados no IndexedDB |
| Markdown: react-markdown + remark-gfm | sem HTML cru |
| Código: Shiki lazy (`shiki/core` + engine JS) | highlight correto sem wasm e sem peso no carregamento inicial |
| Ícones: lucide-react | já usado nos projetos |
| Testes: Vitest | núcleo em Node; `fake-indexeddb` cobre o adaptador Dexie e o `navigator.locks` do Node cobre o adaptador de locks |
| Testes de UI: Vitest browser mode + Playwright | jsdom não mede long task, rAF nem IndexedDB real; o orçamento da §9 só vale medido em navegador |
| Gate: size-limit | o orçamento da §9 precisa falhar `npm run size`/`npm run check` |

Sem router na v1: uma tela, Conversa selecionada em estado da UI. Sem SDK de IA: o adaptador é pequeno e o contrato que queremos é o do domínio.

Publicação, domínio e CI/CD estão em [deployment.md](deployment.md).

## 12. Depois da v1

1. Importar JSON no formato da exportação (`toi.history`).
2. Raciocínio (`thinking`) com `signature` preservada e reenviada.
3. System prompt e parâmetros (temperatura, `max_tokens`).
4. Contagem exata de tokens via `/v1/messages/count_tokens`.
5. Busca no histórico e no texto.
6. Segundo Provedor (OpenAI, depois OpenCode Go e Google), sobre a separação do [ADR 0008](adr/0008-provider-and-protocol.md).
7. PWA e uso offline do shell.
8. Criptografia da Chave com passphrase, se o modelo de ameaça mudar.
