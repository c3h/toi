# Provedor e Protocolo são adaptadores separados; Conversa e Mensagem gravam o Provedor

O Toi vai falar com mais de um Provedor (OpenAI, Google e OpenCode Go, um de cada vez). O OpenCode Go mostrou que Provedor e formato de API variam de forma independente: o mesmo gateway atende uns Modelos no formato Messages da Anthropic, outros no Responses da OpenAI e outros no Chat Completions. Um adaptador por Provedor duplicaria o parser de cada formato.

Separamos dois papéis dentro de `adapters`:

- **Protocolo** (`adapters/protocols/<formato>/`): monta o payload, lê o stream, traduz o envelope de erro e entrega Eventos do domínio. Não autentica e não conhece URL.
- **Provedor** (`adapters/providers/<nome>/`): URL, autenticação, headers de acesso pelo navegador, listagem de Modelos, família de cada Modelo e o descritor `ProviderInfo`. Compõe um ou mais Protocolos e implementa a porta `ChatProvider`, que não muda.

`adapters/http/` guarda o que é só HTTP: o parser de SSE, `fetchOrThrow` e `Retry-After`. A copy de erro que nomeia o Provedor vem do descritor, porque um Protocolo pode servir vários Provedores.

A identidade de um Modelo passa a ser `{ provider, id }`: ids colidem entre Provedores (`claude-haiku-5-5` existe na Anthropic e no OpenCode Go). Por isso:

- `Conversation.provider` é o destino do próximo envio, como `model` já era.
- `Message.provider` é quem gerou a resposta do assistant e fica `null` na do user, como `model`. Não lista todos os serviços que receberam o texto.
- `Model` carrega `provider` e `family`. A família é preenchida pelo Provedor; o domínio deixou de conhecer o prefixo `claude-`.
- Cache de Modelos é por Provedor (`models:<provider>`); `lastModel` e as marcações do seletor guardam refs com Provedor.
- O registro do IndexedDB grava `provider` na Conversa e na Mensagem ([ADR 0007](0007-explicit-persisted-formats.md)).
- A exportação ganha `provider` como campo novo, compatível, sem subir `version`.

A UI recebe só `ProviderInfo` via `Toi`: nome com as formas contraídas ("da Anthropic", "à Anthropic"), placeholder e link da Chave e as famílias sugeridas. Nunca endpoint, header ou Protocolo.

## Considered Options

- **Um adaptador por Provedor, sem Protocolo**: menos camadas hoje, mas o OpenCode Go repetiria três parsers que já existiriam em outros adaptadores.
- **Copy genérica ("seu provedor")**: dispensaria o descritor, mas enfraquece a promessa de privacidade, que é verificável justamente porque nomeia o destino.
- **Ler `provider` ausente como Anthropic**: deixaria um fallback permanente na leitura, contra o [ADR 0007](0007-explicit-persisted-formats.md).

## Consequences

- Esta etapa não adiciona Provedor: `ProviderId` continua `'anthropic'`. A CSP e o `AGENTS.md` só mudaram depois, para o Serviço das Ferramentas ([ADR 0010](0010-web-tools-via-tinyfish.md)). Cada Provedor novo exige antes provar CORS no navegador com os endpoints e headers reais, e abre a própria origem em `public/_headers`.
- Com um Provedor registrado, a UI não oferece escolha; a tela de escolha e o agrupamento por Provedor entram com o segundo.
- `toi.connect`/`disconnect` recebem o Provedor; "apagar tudo" limpa todas as Chaves, inclusive de Provedor que saiu do registro.
- O Fluxo continua um só por `Toi` ([ADR 0005](0005-flow-as-module.md)) e captura o Provedor no início; o Fluxo em voo nunca troca de Provedor. O Lock continua por Conversa.
- Retry grava Provedor e Modelo de destino antes da rede: uma tentativa que falha antes de `started` fica atribuída a quem foi chamado.
- Uma Conversa pode trocar de Provedor; o texto volta a qualquer um, então o histórico é portátil. Raciocínio só volta dentro da resposta em curso, e Partes de Ferramenta só ao Provedor que as gerou e quando o envio oferece Ferramentas ([ADR 0010](0010-web-tools-via-tinyfish.md)).
- Ainda não resolvido, para o Provedor que precisar: Protocolo por Modelo (OpenCode Go), escolha explícita quando o Provedor da Conversa não está conectado e falha parcial ao listar Modelos de vários Provedores (hoje uma falha derruba o refresh inteiro).
