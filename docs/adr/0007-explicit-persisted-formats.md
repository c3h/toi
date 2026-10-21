# Formatos persistidos são escritos à mão, separados do domínio

O IndexedDB gravava os tipos do domínio diretamente, e a exportação congelaria a mesma forma num arquivo que sai do app. Assim, qualquer mudança no domínio mudaria em silêncio dados já gravados e arquivos já exportados. Decidimos ter dois formatos explícitos, cada um com tipos próprios e conversores campo a campo: o registro do IndexedDB (`adapters/storage/records.ts`) e o arquivo de exportação (`app/export.ts`, `format: "toi.history"`, `version: 1`). Mudar o domínio quebra a compilação de um conversor em vez de mudar o dado. A forma da v1 é idêntica ao domínio da v1, então não há migração.

## Considered Options

- **Gravar o domínio direto** (decisão anterior): menos código, mas o schema muda sem ninguém decidir.
- **Um só formato para IndexedDB e exportação**: menos duplicação, mas acopla o ritmo de migração do banco local ao contrato de arquivos que outras versões do app vão ler.

## Consequences

- Mudar a forma gravada exige uma nova `version(n)` com `upgrade()` em `db.ts`; a versão anterior nunca é editada.
- Mudança incompatível no arquivo sobe `version`; a importação, quando existir, lê as versões anteriores.
- Enumerações (`StopReason`, `AppErrorCode`) continuam vindo do domínio: acrescentar um valor é compatível.
- O contrato do store verifica uma Mensagem com todos os campos na ida e na volta, contra memória e Dexie.
