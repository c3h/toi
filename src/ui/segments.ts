import {
  resultsByCall,
  type Message,
  type ToolCallPart,
  type ToolResultPart,
} from '../domain/message';
import { hostOf } from '../domain/web';

export type Segment =
  | { kind: 'text'; text: string }
  /** `result` é `null` enquanto a Ferramenta corre ou se a resposta parou antes dela. */
  | { kind: 'tool'; call: ToolCallPart; result: ToolResultPart | null };

/**
 * A resposta na ordem em que aconteceu: texto contíguo vira um trecho, cada
 * chamada de Ferramenta vira uma linha com o resultado dela. Raciocínio não
 * aparece.
 */
export const segmentsOf = (message: Pick<Message, 'parts'>): Segment[] => {
  const results = resultsByCall(message.parts);
  const segments: Segment[] = [];

  for (const part of message.parts) {
    if (part.type === 'text') {
      const last = segments[segments.length - 1];
      if (last?.kind === 'text') {
        segments[segments.length - 1] = { kind: 'text', text: `${last.text}\n\n${part.text}` };
      } else {
        segments.push({ kind: 'text', text: part.text });
      }
    } else if (part.type === 'tool_call') {
      segments.push({ kind: 'tool', call: part, result: results.get(part.callId) ?? null });
    }
  }

  return segments;
};

/** `exemplo.com` de `https://www.exemplo.com/a`; a URL inteira se não for URL. */
export const domainOf = (url: string): string => hostOf(url).replace(/^www\./, '');
