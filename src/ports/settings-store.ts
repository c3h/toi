/**
 * Configurações não são segredo. Na v1 a porta só expõe o que "apagar tudo"
 * precisa; leitura e escrita entram com a UI.
 */
export interface SettingsStore {
  clear(): Promise<void>;
}
