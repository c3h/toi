# Abas se coordenam por Web Locks

Duas abas compartilham o mesmo IndexedDB e nada as coordenava: as duas podiam enviar na mesma Conversa e gravar o mesmo `seq`, apagar o histórico enquanto a outra ainda gravava (o flush recriava a Mensagem órfã) e só distinguir um Fluxo vivo de um morto por um heartbeat de 15 s. Decidimos coordenar por Web Locks (`navigator.locks`), atrás da porta `Locks`. Quem escreve numa Conversa segura `toi:history` em modo shared e `toi:conversation:<id>` em modo exclusive, do cálculo do `seq` até o fim do Fluxo; apagar o histórico segura `toi:history` em modo exclusive. Nenhuma operação espera: se o lock está com outro dono, a resposta é `flow_busy`. O navegador solta o lock quando a página morre, então conseguir o lock de uma Conversa prova que o Fluxo dela não tem mais dono — essa passa a ser a regra de recuperação.

## Considered Options

- **Só o Lease do Fluxo** (decisão anterior): não serializa o `seq`, deixa uma janela de 15 s sem recuperação e não sabe quando a aba fechou de fato.
- **`BroadcastChannel` com eleição de líder**: resolveria a coordenação, mas é um protocolo próprio para escrever e testar, e quem morre sem avisar continua sendo detectado por timeout.
- **SharedWorker dono de toda escrita**: um único escritor, mas tira a orquestração do `app` e cria um segundo contexto de execução para depurar e testar.
- **Manter o Lease do Fluxo como fallback** (superada em 2026-10-21): cobria contexto inseguro e navegador sem `navigator.locks`, ao custo de um campo gravado em toda Mensagem, heartbeat a cada Evento e um segundo caminho de recuperação. Os navegadores-alvo têm Web Locks e o app roda em HTTPS ou `localhost`.
- **Esperar o lock em vez de recusar**: o composer da segunda aba ficaria pendurado durante um Fluxo inteiro sem explicação.

## Consequences

- O app exige `navigator.locks`; não há coordenação alternativa. `MemoryLocks` existe só nos testes, onde duas instâncias de `Flow` com o mesmo objeto simulam duas abas.
- A recuperação relê a Mensagem sob o lock antes de marcá-la `interrupted`, porque o Fluxo pode ter fechado entre a listagem e a aquisição.
- Soltar um Web Lock é assíncrono: `Release` devolve uma Promise e quem solta espera, ou a próxima aquisição da mesma aba pode encontrar o lock ainda preso.
- `flow_busy` passa a significar também "em uso em outra aba"; a UI precisa dizer isso, porque o composer daquela aba não está desabilitado.
