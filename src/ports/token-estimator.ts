import type { Attachment } from '../domain/attachment';

/** Estimativa para o orçamento de contexto; a contagem exata é outra decisão (§12). */
export interface TokenEstimator {
  estimate(text: string): number;
  estimateAttachment(attachment: Attachment): number;
}
