# Formatos persistidos são escritos à mão, separados do domínio

O IndexedDB gravava os tipos do domínio diretamente, e a exportação congelaria a mesma forma num arquivo que sai do app. Assim, qualquer mudança no domínio mudaria em silêncio dados já gravados e arquivos já exportados. Decidimos ter dois formatos explícitos, cada um com tipos próprios e conversores campo a campo: o registro do IndexedDB (`adapters/storage/records.ts`) e o arquivo de exportação (`app/export.ts`, `format: "toi.history"`, `version: 1`). Mudar o domínio quebra a compilação de um conversor em vez de mudar o dado. A forma da v1 é idêntica ao domínio da v1, então não há migração.

## Considered Options

- **Gravar o domínio direto** (decisão anterior): menos código, mas o schema muda sem ninguém decidir.
- **Um só formato para IndexedDB e exportação**: menos duplicação, mas acopla o ritmo de migração do banco local ao contrato de arquivos que outras versões do app vão ler.

## Consequences

- Em pré-produção, mudar a forma gravada edita a `version(1)` em `db.ts`, sem `upgrade()`. Isso superou, em 2026-10-21, a regra de uma nova `version(n)` por mudança: sem usuário, a migração só protegia o banco de desenvolvimento, e o Dexie 4 abre esse banco mesmo com a versão declarada menor que a instalada.
- Mudança incompatível no arquivo sobe `version`; a importação, quando existir, lê as versões anteriores.
- Enumerações (`StopReason`, `AppErrorCode`) continuam vindo do domínio: acrescentar um valor é compatível.
- O contrato do store verifica uma Mensagem com todos os campos na ida e na volta, contra memória e Dexie.
- As Partes `redacted_reasoning`, `tool_call` e `tool_result` entraram no registro e na exportação como tipos novos, sem subir `version` ([ADR 0010](0010-web-tools-via-tinyfish.md)). O input de `tool_call` é JSON copiado por `structuredClone`.
