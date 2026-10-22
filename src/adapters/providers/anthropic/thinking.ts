import type { ThinkingOff } from '../../protocols/anthropic-messages/request';

// O `capabilities` da listagem não diz quem desliga o raciocínio; a regra vem da
// documentação. Modelo fora dela raciocina no Esforço pedido, que nunca dá 400.
const DISABLED = /^claude-(haiku-5-5|opus-5|opus-4-\d|sonnet-5|sonnet-4-\d)(-\d{8})?$/;
const BETWEEN_TOOLS = /^claude-sonnet-5-5(-\d{8})?$/;

/** `null` quando o Modelo sempre raciocina. Os dois valores só valem com Esforço até `high`. */
export const thinkingOff = (model: string): ThinkingOff | null => {
  if (DISABLED.test(model)) return { type: 'disabled' };
  if (BETWEEN_TOOLS.test(model)) return { type: 'between_tools' };
  return null;
};
