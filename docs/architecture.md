# Arquitetura

Desenho da v1. Vocabulário em `CONTEXT.md`; decisões em `docs/adr/`. **Estado:** o núcleo (domínio, adapters, app e persistência) está implementado; a UI inteira ainda falta. §1 descreve o alvo da v1, não o que já existe; o que depende da UI está marcado **(com a UI)** e os critérios da próxima etapa estão em §9–§10.

## 1. Objetivo e escopo

Um chat que responde uma pergunta com um Modelo da Anthropic, com Fluxo, cancelamento e histórico Local, sem backend. A v1 é pequena de propósito; a arquitetura é maior que a v1 para que crescer não exija reescrever o que já existe.

**A v1 faz:**

- adicionar, validar, trocar e remover a Chave;
- listar Modelos via `GET /v1/models` e escolher um;
- criar Conversa, enviar Mensagem, receber Fluxo, parar;
- renomear e apagar Conversas na barra lateral;
- apagar todas as Conversas (preserva a Chave) e apagar tudo (remove a Chave);
- persistir e retomar; Mensagem `streaming` órfã vira `interrupted` na abertura;
- coordenar abas: uma Conversa recebe Mensagens de uma aba por vez;
- exportar o histórico em JSON versionado, sem a Chave;
- Markdown e código na resposta;
- tokens de entrada e saída por Mensagem.

**Fora da v1:** conta, sincronização, compartilhamento, i18n, ferramentas, busca na web, branching e os itens do roadmap (§12).

**Raciocínio fica fora da v1 de propósito.** Blocos `thinking` exigem `signature` preservada e devolvida verbatim nas requisições seguintes; modelá-los agora obrigaria a guardar um campo opaco e a tratar uma exceção no envio. O schema de Partes já comporta o tipo, mas nenhum `thinking` é pedido nem persistido até essa decisão existir.

## 2. Princípios de desenho

1. **Fronteira explícita.** Domínio puro; rede só em adaptadores; a UI não sabe o que é Anthropic.
2. **Uma dependência por problema.** Biblioteca só quando o custo de escrever e manter é maior que o de depender.

As prioridades de produto — dado local, previsibilidade sob falha e leveza medível — e as regras operacionais estão em `AGENTS.md`; o orçamento de leveza está na §9.

## 3. Módulos e dependências

```
src/
  domain/        # tipos e invariantes; zero import externo
  ports/         # contratos e defaults; sem dependência externa
  adapters/
    anthropic/   # provider, request, sse, stream, models, error, types, fetch
    storage/     # db, records, conversations, credentials, settings
    locks/       # web (navigator.locks), memory (fallback)
    tokens/      # heuristic
  app/           # flow, toi, locks, connect, conversations, erase, export, send-message, build-request; sem React
  ui/            # React; placeholder
  main.tsx       # composition root; hoje só monta o placeholder
```

`Flow` (`app/flow.ts`) é o módulo do Fluxo em voo e `Toi` (`app/toi.ts`) é a fachada do app; a UI depende só dos dois. Responsabilidades e porquê em [ADR 0005](adr/0005-flow-as-module.md).

**Regra de dependência:** `ui → app → ports ← adapters`; todos podem importar `domain`; `domain` não importa ninguém. `app` não importa `adapters` e recebe as implementações por injeção. `main.tsx` é o composition root; a injeção das implementações concretas entra com a UI. O adaptador concreto é injetado em `Toi` como `createProvider(key)`.

As portas existem por fronteiras reais: `ChatProvider` isola o HTTP de terceiro e permite um segundo Provedor; o storage permite trocar IndexedDB ou usar memória em teste; `Locks` coordena abas por Web Locks e cai para memória quando o navegador não oferece; `TokenEstimator` permite substituir a heurística pela contagem exata sem tocar no domínio; `SettingsStore` cobre hoje só o que "apagar tudo" precisa — leitura e cache de Modelos entram com a UI.

## 4. Ciclo de uma Mensagem

`Flow.send` (o caso de uso `startSendMessage`):

1. segura os locks da Conversa (§4, Coordenação entre abas) até o passo 7; sem eles, `flow_busy`;
2. grava a Mensagem do user (`complete`) e a do assistant (`streaming`);
3. normaliza o histórico e monta o `ChatRequest` (`build-request`);
4. consome `provider.stream(request, signal)`;
5. para cada Evento aplicado, atualiza a Parte, renova o lease e agenda o flush (300 ms);
6. fecha em `complete`, `interrupted` ou `failed`;
7. devolve `RunResult` e solta os locks; falha de persistência vai em `persistError`, sem reabrir a Mensagem.

```
streaming ── finished ──► complete
          ├─ abort ─────► interrupted
          └─ erro ──────► failed
```

- `interrupted` preserva o texto recebido. Não é erro; a UI oferece "tentar de novo" (com a UI).
- `failed` preserva o texto recebido e guarda o `AppErrorInfo`.
- `finished` marca o fim lógico do Fluxo; o consumo termina quando o corpo fecha. A UI não oferece "parar" depois dele (com a UI). O parser usa `try/finally` e chama `reader.cancel()` quando o consumidor para antes do fim; um `break` no `for await` não fecharia a conexão sozinho.
- **`finished` é terminal:** um erro ou abort depois dele não reabre a Mensagem; o estado final continua `complete`.
- Se o flush final falhar, a Mensagem continua `complete` em memória e `RunResult.persistError` carrega o erro; a UI avisa que a resposta não foi salva.
- **Tentar de novo substitui a última Mensagem do assistant** (mesmo id, Partes limpas, estado `streaming`). É a única mutação permitida numa Mensagem. Sem isso, a Conversa acumularia duas respostas para o mesmo pedido.
- Enquanto há Fluxo, o composer fica desabilitado e só existe "parar" (com a UI). Isso elimina o caso de uma segunda Mensagem do user durante o Fluxo.
- O construtor de requisição funde Mensagens consecutivas do mesmo papel, descarta Mensagens sem texto e assistant nas pontas, nunca envia uma Mensagem `streaming` e exige que a última seja do user.

### Identidade e ordem

Cada Mensagem tem `seq`, um inteiro monotônico por Conversa, atribuído pelo app sob o lock da Conversa — duas abas não calculam o mesmo `seq`. O Dexie indexa `conversationId` e `[conversationId+seq]`; a leitura ordena por `seq`. `createdAt` serve para exibir, não para ordenar.

O Título é derivado na primeira Mensagem do user: os primeiros ~60 caracteres, cortados no limite de palavra. Nenhuma chamada extra ao Modelo só para nomear.

### Coordenação entre abas e Lease do Fluxo

Decisão e alternativas no [ADR 0006](adr/0006-web-locks-cross-tab.md). `app/locks.ts` define os nomes e a regra: escrever numa Conversa (enviar, tentar de novo, apagá-la) segura `toi:history` shared + `toi:conversation:<id>` exclusive; apagar Conversas e apagar tudo seguram `toi:history` exclusive. Nada espera: lock ocupado vira `flow_busy`.

Na abertura, `createToi` chama `recoverInterrupted`. Com Web Locks, cada Mensagem `streaming` cuja Conversa tem o lock livre é relida sob os mesmos locks de quem escreve (`toi:history` shared e o lock da Conversa) e vira `interrupted`: o navegador solta o lock quando a página morre, então lock livre prova Fluxo sem dono. Histórico sendo apagado em outra aba também conta como ocupado.

Sem Web Locks, vale o Lease: a Mensagem `streaming` guarda `stream.owner` (id da aba, em `sessionStorage`, fornecido pela UI ao `createToi`) e `stream.heartbeatAt`, renovado a cada Evento aplicado e gravado junto no flush. A recuperação converte quando não há lease ou quando `isLeaseExpired` é verdadeiro (15 s por default, `DEFAULT_LEASE_MS` em `domain/message.ts`). O Lease é gravado sempre, para que o fallback funcione com dados de qualquer aba.

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
| `ChatRequest.system` / `temperature` | `system` / `temperature`, só quando definidos |
| `delta` de texto | `content_block_delta` → `text_delta` |
| `usage` | `message_start.usage` + `message_delta.usage` |
| `stopReason` | `message_delta.delta.stop_reason` |

A porta carrega Partes, não texto ([ADR 0003](adr/0003-message-as-parts-and-normalized-events.md)): raciocínio, imagem e ferramentas entram sem mudar o contrato. `system` e `temperature` existem na porta, mas a v1 não os preenche; system prompt é sempre campo próprio, nunca Mensagem.

Requisição:

```
POST https://api.anthropic.com/v1/messages
x-api-key: <Chave>
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
content-type: application/json

{ model, max_tokens, messages, stream: true, system?, temperature? }
```

`max_tokens` é obrigatório. Default: `Math.min(8192, model.max_tokens ?? 8192)`.

Modelos:

```
GET https://api.anthropic.com/v1/models?limit=1000
```

Seguimos `has_more`/`last_id` por até 20 páginas e descartamos `lifecycle` diferente de `active` quando presente. Guardamos `id`, `display_name`, `max_tokens`, `max_input_tokens` e `created_at`. Nenhum ID de Modelo é fixo no código.

Com a UI, a lista será cacheada em `settings` e atualizada quando a Chave mudar ou a pessoa pedir. Com a UI, se a listagem falhar e existir cache, usamos o cache marcado como desatualizado; se falhar sem cache, a primeira execução mostra o erro com "tentar de novo" — não há caminho silencioso.

### Primeira execução (com a UI)

1. Sem Chave: onboarding pede a Chave.
2. "Validar" = `GET /v1/models` com a Chave candidata. Não gastamos uma chamada de `messages`.
3. Sucesso: grava a Chave, seleciona o Modelo ativo mais recente e abre a primeira Conversa.
4. Falha: erro tipado, sem gravar a Chave, com "tentar de novo".
5. Lista vazia: estado explícito "nenhum Modelo disponível para esta Chave", com retry.

`createToi` lê a Chave salva na abertura; `connect` valida com `listModels` e só então grava, de modo que uma Chave inválida não substitui a anterior.

## 6. Persistência

IndexedDB via Dexie. O schema está em `src/adapters/storage/db.ts`: `conversations` indexa `id` e `updatedAt`; `messages` indexa `id`, `conversationId`, `[conversationId+seq]` e `status`; `settings` indexa `key`; `credentials` indexa `provider`.

| Store | Conteúdo | Nunca contém |
|---|---|---|
| `conversations` | id, título, modelo, timestamps | Mensagens |
| `messages` | id, conversationId, seq, papel, partes, estado, uso, stopReason, erro, lease | Chave |
| `settings` | tema, último Modelo, cache de Modelos | Chave |
| `credentials` | Provedor → Chave | Qualquer dado de Conversa |

**Formato gravado:** o adaptador converte o domínio para registros escritos à mão (`adapters/storage/records.ts`) e de volta; mudar a forma gravada é uma nova `version(n)` com `upgrade()` em `db.ts` ([ADR 0007](adr/0007-explicit-persisted-formats.md)).

**Erro serializável:** `Message.error` guarda `AppErrorInfo` — código, mensagem, detalhe e `retryAfterSeconds` —, um objeto plano. Structured clone não preserva protótipo de classe; ler do IndexedDB e usar `instanceof AppError` falharia.

**Escrita durante o Fluxo:** a Mensagem em memória é a fonte da verdade; o IndexedDB recebe flush conforme §4. Gravar por token é desperdício e trava a thread. O storage já implementa schema, Conversas, credenciais e settings; o lease é persistido na Mensagem. Cache de Modelos, `navigator.storage.persist()` e os ganchos de página entram com a UI.

**Storage persistente (com a UI):** `navigator.storage.persist()` na criação da primeira Conversa. Se negado, aviso em Configurações. Safari/ITP pode descartar o armazenamento após ~7 dias sem interação, mesmo com o pedido aceito; isso é limitação visível, não nota de rodapé.

**Seleção de Conversa (com a UI):** estado efêmero da UI, espelhado em `sessionStorage` para sobreviver a reload. Não é `settings`: duas abas podem ter seleções diferentes.

**Modelo:** `conversation.model` é a fonte da verdade. O seletor muda a Conversa atual; `settings.lastModel` só define o default de uma Conversa nova (com a UI).

**Duas abas:** a seleção é independente; Mensagens de uma Conversa são escritas por uma aba por vez (§4). Metadados da Conversa, como Título e Modelo, seguem last write wins. Sem merge de texto entre abas.

**Exportação:** `toi.exportHistory()` devolve um retrato do histórico no formato `toi.history` versão 1 (`app/export.ts`); a UI só transforma em arquivo. Lê apenas a porta de Conversas, então a Chave não tem caminho até o arquivo. Mensagem em Fluxo sai como `interrupted` e sem Lease.

**Apagar conversas** limpa `conversations` e `messages`; **apagar tudo** também remove Configurações e Chave, por composição no app ([ADR 0004](adr/0004-indexeddb-separate-credential-store.md)). Duas ações distintas, ambas com confirmação explícita (com a UI).

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
| `invalid_request` | 400 (outros) | Detalhe técnico |
| `rate_limited` | 429 ou `rate_limit_error` | Botão repetir, usando `retryAfterSeconds` |
| `overloaded` | 529 ou `overloaded_error` | Botão repetir |
| `api_error` | 5xx | Botão repetir |
| `unreachable` | `TypeError` no fetch, offline, CORS bloqueado ou Fluxo encerrado sem `finished` | Botão repetir |
| `aborted` | `AbortError` | Estado `interrupted` |
| `not_connected` | `send`/`retry` sem Chave | Abrir onboarding |
| `flow_busy` | `send`/`retry`/apagar com Fluxo em voo ou limpeza em andamento, nesta ou em outra aba | Avisar; na própria aba o composer já fica desabilitado |
| `storage_failed` | IndexedDB recusou o flush final (`RunResult.persistError`) | Avisar que a resposta não foi salva |
| `unknown` | qualquer outro | Detalhe técnico |

As mensagens genéricas ficam em `src/domain/error.ts` (`appError`, `messageFor`, `truncatedError`); o adaptador sobrescreve as que nomeiam o Provedor (`api_error`, `unreachable`) e acrescenta detalhe. A UI nunca mostra o texto cru da API e a Chave nunca entra em mensagem de erro.

O navegador não distingue CORS de queda de rede: ambos chegam como `TypeError` sem status nem corpo. Por isso `unreachable` cobre as duas hipóteses, e `browser_access_blocked` só existe quando o corpo do 401 é legível — ou seja, quando o preflight passou.

Não há retry automático na v1: "repetir" é sempre ação da pessoa e substitui a última Mensagem do assistant.

### Crescimento do contexto

Toda Mensagem reenvia o histórico. `build-request` estima tokens com `TokenEstimator` (heurística de ~3,5 caracteres por token) e, acima de 80% de `max_input_tokens` (ou de 200 mil quando a API não informar), descarta turnos do meio preservando o primeiro turno e os turnos mais recentes que couberem, sempre incluindo o atual. O turno atual entra mesmo se sozinho estourar o orçamento; nesse caso a API recusa com `context_overflow` e a UI oferece uma Conversa nova. Quando houver corte, a UI avisa que parte do meio saiu do contexto (com a UI). Contagem exata via `/v1/messages/count_tokens` fica para a v1.1.

## 8. Segurança

**Modelo de ameaça.** Quem tem acesso ao perfil do navegador; código malicioso rodando na origem; dependência comprometida. Fora do escopo: a Anthropic (que recebe a Conversa por contrato), interceptação de rede (TLS) e acesso físico ao disco.

- A Chave fica no IndexedDB, nunca em URL, log, mensagem de erro ou exportação.
- CSP de produção em `public/_headers` (Cloudflare Pages e equivalentes): `default-src` e `script-src` em `'self'`, `connect-src` só `'self'` e `https://api.anthropic.com`, `object-src`, `base-uri`, `frame-ancestors` e `form-action` em `'none'`. O header é a fonte da verdade. Se o host não permitir headers, o fallback `<meta http-equiv="Content-Security-Policy">` ignora `frame-ancestors`, `base-uri` e `form-action` — nesse caso o host está errado para este produto.

- Com a UI: sem `dangerouslySetInnerHTML`; Markdown sem `rehype-raw`; links externos com `rel="noopener noreferrer"` e `target="_blank"`.
- Sem script, fonte ou analytics de terceiro. Ícones e fontes entram no bundle quando a UI entrar.
- **Supply chain é risco residual declarado:** uma dependência comprometida no bundle lê a Chave no IndexedDB. Lockfile, `npm ci`, número mínimo de dependências e revisão de diff reduzem a chance; não eliminam. `npm audit` detecta vulnerabilidade conhecida, não pacote malicioso novo.

## 9. Performance

Orçamento da v1. O que já é medível passa por `npm run size`; o resto são critérios de aceite da UI:

- **JS inicial ≤ 150 KB gzip**, medido com `size-limit` no build de produção; o gate local falha acima. Markdown, Shiki e o painel de Configurações ficam em chunks lazy e não entram na conta.
- **Nenhuma long task > 50 ms durante um Fluxo de 500 deltas**, medido com `PerformanceObserver` numa página de teste; deltas são acumulados em buffer e aplicados ao React no máximo uma vez por frame (rAF).
- Só a Mensagem em Fluxo re-renderiza; a lista é memoizada por id + estado; o scroll acompanha o fim apenas se a pessoa já estava no fim.
- **Markdown em Fluxo por blocos:** o texto é dividido em blocos de nível superior; blocos fechados são memoizados e só o último é reprocessado a cada frame. Reprocessar o texto inteiro por frame cresce com o tamanho da resposta e estoura o orçamento de long task.
- **Shiki enxuto:** `shiki/core` com o engine de regex em JavaScript (sem wasm) e grammars carregadas sob demanda; o highlight roda quando o bloco de código fecha, nunca a cada delta.

A UI ainda é um placeholder; os critérios de main thread e re-render valem para a próxima etapa. Tempo de primeira interação não é orçamento: depende da rede e da máquina. O que controlamos é bytes, trabalho de main thread e número de re-renders.

## 10. Testes

| Fronteira | O que testa | Como |
|---|---|---|
| `domain` | título, normalização de texto e expiração do lease | Vitest puro |
| `adapters/anthropic` | parser SSE, mappers e classificação de erros HTTP | streams SSE montados no teste: texto, `ping`, `error`, evento desconhecido, chunk cortado no meio de um caractere Unicode; casos principais de status; `retry-after` em segundos e em data com clock fixo |
| `adapters/storage` | contrato da porta, schema, cascata e fronteira da Chave | `MemoryStore` + Dexie com `fake-indexeddb` |
| `app/build-request` | fusão de papéis, descarte de Mensagens vazias, truncamento | Vitest puro |
| `app/send-message` | enviar, abortar, falhar, retry, `finished` terminal, falha de persistência | Provedor fake + store em memória |
| `app/flow` | um Fluxo por vez, `stop` (também antes do Fluxo começar), `flush`, `exclusive`, sem Provedor, duas abas na mesma Conversa | Provedor fake + store em memória; duas instâncias de `Flow` com os mesmos locks simulam duas abas |
| `app/recover-interrupted` | com locks: lock livre, lock ocupado, histórico sendo apagado, Mensagem fechada entre listar e travar; sem locks: lease vencido, vivo e ausente | clock fixo + store e locks em memória |
| `adapters/locks` | exclusive, shared e a soltura assíncrona | `MemoryLocks` e `WebLocks` contra o `navigator.locks` real do Node |
| `app/export` | formato, Fluxo em voo, ordem e ausência da Chave | store em memória |
| `app/toi`/`connect` | validar antes de gravar, Chave anterior preservada, histórico, recuperar, apagar só a Conversa em voo, recusar envio durante apagar tudo, recusar limpeza com Fluxo em outra aba, exportar | fakes de store, credencial, settings e Provedor; um caso com Web Locks reais |
| `ui` | enviar e ver a resposta, parar, recarregar no meio do Fluxo, duas abas, orçamento da §9 | próxima etapa: Vitest em modo browser (Playwright) para componentes e E2E com Playwright, ambos em navegador real; sem snapshot |

Regras: teste não usa `sleep`; debounce usa fake timers e lease usa clock injetado. Teste de regressão fica vermelho no código anterior. Nada de teste que só confirme wiring.

## 11. Stack

Instalados: Vite, React 19, TypeScript, Dexie e Vitest; `fake-indexeddb` nos testes do storage. Com a UI entram Tailwind, react-markdown, Shiki, lucide, o modo browser do Vitest e Playwright.

| Peça | Por quê |
|---|---|
| UI: React + Tailwind | padrão dos projetos, sem biblioteca de componentes |
| Estado: `useSyncExternalStore` sobre `Toi`/`Flow` | o app já é a fonte da verdade; uma store de UI duplicaria o estado do Fluxo. O histórico precisa de uma notificação de mudança na porta (no Dexie, `liveQuery`, que também vê outras abas) — entra com a UI |
| Coordenação entre abas: Web Locks | o navegador solta o lock quando a página morre; sem dependência ([ADR 0006](adr/0006-web-locks-cross-tab.md)) |
| Persistência: Dexie | schema versionado e migrações no IndexedDB |
| Markdown: react-markdown + remark-gfm | sem HTML cru |
| Código: Shiki lazy (`shiki/core` + engine JS) | highlight correto sem wasm e sem peso no carregamento inicial |
| Ícones: lucide-react | já usado nos projetos |
| Testes: Vitest | núcleo em Node; `fake-indexeddb` cobre o adaptador Dexie e o `navigator.locks` do Node cobre o adaptador de locks |
| Testes de UI: Vitest browser mode + Playwright | jsdom não mede long task, rAF nem IndexedDB real; o orçamento da §9 só vale medido em navegador |
| Gate: size-limit | o orçamento da §9 precisa falhar `npm run size`/`npm run check` |

Sem router na v1: uma tela, Conversa selecionada em estado da UI. Sem SDK de IA: o adaptador é pequeno e o contrato que queremos é o do domínio.

## 12. Depois da v1

1. Importar JSON no formato da exportação (`toi.history`).
2. Raciocínio (`thinking`) com `signature` preservada e reenviada.
3. System prompt e parâmetros (temperatura, `max_tokens`).
4. Contagem exata de tokens via `/v1/messages/count_tokens`.
5. Busca no histórico e no texto.
6. Anexos de imagem (base64 na Mensagem; `/v1/files` não suporta CORS).
7. Segundo Provedor como novo adaptador.
8. PWA e uso offline do shell.
9. Criptografia da Chave com passphrase, se o modelo de ameaça mudar.
