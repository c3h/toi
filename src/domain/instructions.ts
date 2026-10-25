/** Caracteres das Instruções. Passar disso é recusado ao salvar, nunca cortado. */
export const MAX_INSTRUCTIONS_CHARS = 4_000;

/** As Instruções como são gravadas: sem espaço nas pontas, com as quebras de dentro; vazias, `null`. */
export const normalizeInstructions = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
};
