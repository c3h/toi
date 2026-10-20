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
    storage/     # db, conversations, credentials
    tokens/      # heuristic
  app/           # orquestração, sem React
  ui/            # React; placeholder
  main.tsx       # composition root; hoje só monta o placeholder
```

`stop` não é um módulo: a UI mantém o `AbortController` da requisição em voo e chama `abort()`. `retry` vive em `send-message.ts` porque compartilha o motor do Fluxo com `send`.

**Regra de dependência:** `ui → app → ports ← adapters`; todos podem importar `domain`; `domain` não importa ninguém. `app` não importa `adapters` e recebe as implementações por injeção. `main.tsx` é o composition root; a injeção das implementações concretas entra com a UI.

As portas existem por fronteiras reais: `ChatProvider` isola o HTTP de terceiro e permite um segundo Provedor; o storage permite trocar IndexedDB ou usar memória em teste; `TokenEstimator` permite substituir a heurística pela contagem exata sem tocar no domínio.

## 4. Ciclo de uma Mensagem

`sendMessage`:

1. grava a Mensagem do user (`complete`) e a do assistant (`streaming`);
2. normaliza o histórico e monta o `ChatRequest` (`build-request`);
3. consome `provider.stream(request, signal)`;
4. para cada Evento aplicado, atualiza a Parte, renova o lease e agenda o flush (300 ms);
5. fecha em `complete`, `interrupted` ou `failed`.

```
streaming ── finished ──► complete
          ├─ abort ─────► interrupted
          └─ erro ──────► failed
```

- `interrupted` preserva o texto recebido. Não é erro; a UI oferece "tentar de novo" (com a UI).
- `failed` preserva o texto recebido e guarda o `AppErrorInfo`.
- `finished` marca o fim lógico do Fluxo; o consumo termina quando o corpo fecha. A UI não oferece "parar" depois dele (com a UI). O parser usa `try/finally` e chama `reader.cancel()` quando o consumidor para antes do fim; um `break` no `for await` não fecharia a conexão sozinho.
- **Tentar de novo substitui a última Mensagem do assistant** (mesmo id, Partes limpas, estado `streaming`). É a única mutação permitida numa Mensagem. Sem isso, a Conversa acumularia duas respostas para o mesmo pedido.
- Enquanto há Fluxo, o composer fica desabilitado e só existe "parar" (com a UI). Isso elimina o caso de uma segunda Mensagem do user durante o Fluxo.
- O construtor de requisição funde Mensagens consecutivas do mesmo papel, descarta Mensagens sem texto e assistant nas pontas, nunca envia uma Mensagem `streaming` e exige que a última seja do user.

### Identidade e ordem

Cada Mensagem tem `seq`, um inteiro monotônico por Conversa, atribuído pelo app. O Dexie indexa `conversationId` e `[conversationId+seq]`; a leitura ordena por `seq`. `createdAt` serve para exibir, não para ordenar.

O Título é derivado na primeira Mensagem do user: os primeiros ~60 caracteres, cortados no limite de palavra. Nenhuma chamada extra ao Modelo só para nomear.

### Lease do Fluxo

A Mensagem `streaming` guarda `stream.owner` (id aleatório da aba, em `sessionStorage`, com a UI) e `stream.heartbeatAt`, renovado a cada Evento aplicado; o flush grava a Mensagem com o lease junto. Na abertura, `recover-interrupted` — chamado pela UI — converte para `interrupted` quando não há lease ou quando o heartbeat tem 15 s ou mais. Sem o lease, abrir uma segunda aba marcaria como interrompido o Fluxo que a primeira está gravando.

### Cancelamento e durabilidade

Um `AbortController` por requisição em voo, mantido pela UI. `abort()` faz o app fechar a Mensagem como `interrupted` e dar flush. O flush também roda em `pagehide` e `visibilitychange` (com a UI). Com flush a cada 300 ms, até 300 ms de tokens podem se perder num crash — aceito e documentado.

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
| `Message[]` | `messages[]` com `content` como string (a v1 só tem texto) |
| `Part.text` | concatenado no `content` da Mensagem pelo `build-request` |
| `delta` de texto | `content_block_delta` → `text_delta` |
| `usage` | `message_start.usage` + `message_delta.usage` |
| `stopReason` | `message_delta.delta.stop_reason` |

`ChatRequest` da v1 não tem `system`: nenhum system prompt é enviado. Quando existir, entra como campo separado, nunca como Mensagem.

Requisição:

```
POST https://api.anthropic.com/v1/messages
x-api-key: <Chave>
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
content-type: application/json

{ model, max_tokens, messages, stream: true }
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

## 6. Persistência

IndexedDB via Dexie. O schema está em `src/adapters/storage/db.ts`: `conversations` indexa `id` e `updatedAt`; `messages` indexa `id`, `conversationId`, `[conversationId+seq]` e `status`; `settings` indexa `key`; `credentials` indexa `provider`.

| Store | Conteúdo | Nunca contém |
|---|---|---|
| `conversations` | id, título, modelo, timestamps | Mensagens |
| `messages` | id, conversationId, seq, papel, partes, estado, uso, erro, lease | Chave |
| `settings` | tema, último Modelo, cache de Modelos | Chave |
| `credentials` | Provedor → Chave | Qualquer dado de Conversa |

**Erro serializável:** `Message.error` guarda `AppErrorInfo` — código, mensagem, detalhe e `retryAfterSeconds` —, um objeto plano. Structured clone não preserva protótipo de classe; ler do IndexedDB e usar `instanceof AppError` falharia.

**Escrita durante o Fluxo:** a Mensagem em memória é a fonte da verdade; o IndexedDB recebe flush conforme §4. Gravar por token é desperdício e trava a thread. O storage já implementa schema, Conversas e credenciais; o lease é persistido na Mensagem. Cache de Modelos, `navigator.storage.persist()` e os ganchos de página entram com a UI.

**Storage persistente (com a UI):** `navigator.storage.persist()` na criação da primeira Conversa. Se negado, aviso em Configurações. Safari/ITP pode descartar o armazenamento após ~7 dias sem interação, mesmo com o pedido aceito; isso é limitação visível, não nota de rodapé.

**Seleção de Conversa (com a UI):** estado efêmero no Zustand, espelhado em `sessionStorage` para sobreviver a reload. Não é `settings`: duas abas podem ter seleções diferentes.

**Modelo:** `conversation.model` é a fonte da verdade. O seletor muda a Conversa atual; `settings.lastModel` só define o default de uma Conversa nova (com a UI).

**Duas abas:** a seleção é independente; a escrita na mesma Conversa é last write wins, exceto pelo lease (§4), que impede a recuperação de marcar como interrompido um Fluxo vivo. Sem merge de texto entre abas.

**Apagar conversas** limpa `conversations` e `messages`. **Apagar tudo** limpa também `settings` e `credentials`. Duas ações distintas, ambas com confirmação explícita (com a UI).

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
| `unknown` | qualquer outro | Detalhe técnico |

As mensagens visíveis ficam em `src/adapters/anthropic/error.ts`; a UI nunca mostra o texto cru da API. A Chave nunca entra em mensagem de erro.

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
- Só a Mensagem em Fluxo re-renderiza; a lista é memoizada por id + estado; o scroll acompanha o fim apenas se a pessoa já estava no fim; Markdown incremental é memoizado por Mensagem concluída.

A UI ainda é um placeholder; os critérios de main thread e re-render valem para a próxima etapa. Tempo de primeira interação não é orçamento: depende da rede e da máquina. O que controlamos é bytes, trabalho de main thread e número de re-renders.

## 10. Testes

| Fronteira | O que testa | Como |
|---|---|---|
| `domain` | título e normalização de texto | Vitest puro |
| `adapters/anthropic` | parser SSE, mappers e classificação de erros HTTP | streams SSE montados no teste: texto, `ping`, `error`, evento desconhecido, chunk cortado no meio de um caractere Unicode; casos principais de status |
| `adapters/storage` | schema, Conversas, credenciais e erase | próxima etapa: `fake-indexeddb` |
| `app/build-request` | fusão de papéis, descarte de Mensagens vazias, truncamento | Vitest puro |
| `app` | enviar, abortar, falhar, retry, recuperar com e sem lease, renovar heartbeat, flusher | Provedor fake + store em memória |
| `ui` | fluxo de enviar e ver a resposta | próxima etapa: um teste de integração; sem snapshot |

Regras: teste não usa `sleep`; debounce usa fake timers e lease usa clock injetado. Teste de regressão fica vermelho no código anterior. Nada de teste que só confirme wiring.

## 11. Stack

Instalados: Vite, React 19, TypeScript, Dexie, Zustand e Vitest. Com a UI entram Tailwind, react-markdown, Shiki, lucide e Testing Library.

| Peça | Por quê |
|---|---|
| UI: React + Tailwind | padrão dos projetos, sem biblioteca de componentes |
| Estado: Zustand | pequeno, selectors, sem provider hell |
| Persistência: Dexie | schema versionado e migrações no IndexedDB |
| Markdown: react-markdown + remark-gfm | sem HTML cru |
| Código: Shiki lazy | highlight correto sem peso no carregamento inicial |
| Ícones: lucide-react | já usado nos projetos |
| Testes: Vitest + Testing Library | rápido, sem browser |
| Gate: size-limit | o orçamento da §9 precisa falhar `npm run size`/`npm run check` |
| E2E: Playwright (v1.1) | só quando o fluxo estabilizar |

Sem router na v1: uma tela, Conversa selecionada no Zustand. Sem SDK de IA: o adaptador é pequeno e o contrato que queremos é o do domínio.

## 12. Depois da v1

1. Exportar e importar JSON.
2. Raciocínio (`thinking`) com `signature` preservada e reenviada.
3. System prompt e parâmetros (temperatura, `max_tokens`).
4. Contagem exata de tokens via `/v1/messages/count_tokens`.
5. Busca no histórico e no texto.
6. Anexos de imagem (base64 na Mensagem; `/v1/files` não suporta CORS).
7. Segundo Provedor como novo adaptador.
8. PWA e uso offline do shell.
9. Criptografia da Chave com passphrase, se o modelo de ameaça mudar.
