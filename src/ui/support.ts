import { asAppError, toErrorInfo, type AppErrorInfo } from '../domain/error';

/** Toda falha vira `AppErrorInfo`; a UI nunca mostra o texto cru de uma exceção. */
export const errorInfo = (error: unknown): AppErrorInfo =>
  toErrorInfo(asAppError(error));

/** Pede para o navegador não descartar o histórico; negar dá `false` e não bloqueia nada. */
export const requestPersistence = (): Promise<boolean> =>
  navigator.storage.persist().catch(() => false);

const SELECTED_KEY = 'toi:selected';

/** Seleção é estado da aba: sobrevive a reload, mas outra aba tem a sua. */
export const selection = {
  read(): string | null {
    try {
      return sessionStorage.getItem(SELECTED_KEY);
    } catch {
      return null;
    }
  },

  write(id: string | null): void {
    try {
      if (id === null) sessionStorage.removeItem(SELECTED_KEY);
      else sessionStorage.setItem(SELECTED_KEY, id);
    } catch {
      // Sem sessionStorage a seleção só não sobrevive a reload.
    }
  },
};

export const formatTokens = (count: number): string => new Intl.NumberFormat('pt-BR').format(count);

export const downloadJson = (name: string, value: unknown): void => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

const DAY = 24 * 60 * 60 * 1000;

/** Grupo da barra lateral pela última atividade. */
export const ageGroup = (updatedAt: number, now: number): string => {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();

  if (updatedAt >= start) return 'hoje';
  if (updatedAt >= start - DAY) return 'ontem';
  if (updatedAt >= start - 6 * DAY) return 'últimos 7 dias';
  if (updatedAt >= start - 29 * DAY) return 'últimos 30 dias';
  return 'antes';
};

/** Atalho de uma tecla só vale fora de campos de texto e sem modificador. */
export const isTyping = (event: KeyboardEvent): boolean => {
  const target = event.target as HTMLElement | null;
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    target?.closest('input, textarea, select, [contenteditable="true"]') != null
  );
};

/** A UI escreve em minúsculas, como o blog; as mensagens do domínio começam em maiúscula. */
export const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
