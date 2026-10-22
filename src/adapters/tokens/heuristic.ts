import type { Attachment } from '../../domain/attachment';
import type { TokenEstimator } from '../../ports/token-estimator';

const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD = 4;

const tokensFor = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD;

/** Cada lado da imagem é lido em blocos de 28 px. */
const IMAGE_PATCH = 28;

/** Texto extraído mais a imagem da página, no alto do que a documentação dá como típico. */
const TOKENS_PER_PDF_PAGE = 3_000;

/** Sem a contagem de páginas, um PDF de texto ocupa por volta de 50 KB por página. */
const PDF_BYTES_PER_PAGE = 50_000;

const estimateAttachment = (attachment: Attachment): number => {
  switch (attachment.kind) {
    case 'image':
      return (
        Math.ceil(attachment.width / IMAGE_PATCH) * Math.ceil(attachment.height / IMAGE_PATCH)
      );
    case 'pdf': {
      const pages = attachment.pages ?? Math.ceil(attachment.size / PDF_BYTES_PER_PAGE);
      return pages * TOKENS_PER_PDF_PAGE;
    }
    case 'text':
      // Bytes, não caracteres: superestima texto fora do ASCII, a favor do orçamento.
      return tokensFor(attachment.size);
  }
};

export const heuristicTokenEstimator: TokenEstimator = {
  estimate: (text) => tokensFor(text.length),
  estimateAttachment,
};
