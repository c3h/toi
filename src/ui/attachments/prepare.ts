import {
  fitSide,
  IMAGE_LIMITS,
  imageSize,
  MESSAGE_LIMITS,
  renameFor,
  sniff,
  TEXT_LIMIT_BYTES,
  type AttachmentUpload,
  type ImageMediaType,
  type Sniffed,
} from '../../domain/attachment';
import type { AttachmentId } from '../../domain/ids';
import { countPdfPages } from './pdf-pages';

export type PrepareProblem =
  | 'empty'
  | 'unreadable'
  | 'unsupported'
  | 'heic'
  | 'undecodable'
  | 'too_many_pixels'
  | 'image_too_large'
  | 'pdf_too_large'
  | 'text_too_large';

/** Por que um arquivo não vira Anexo; a copy fica com a UI. */
export class PrepareError extends Error {
  readonly problem: PrepareProblem;

  constructor(problem: PrepareProblem, options?: { cause?: unknown }) {
    super(problem, options);
    this.name = 'PrepareError';
    this.problem = problem;
  }
}

/** O JPEG pode guardar uma miniatura EXIF de até 64 KB antes das dimensões. */
const HEAD_BYTES = 256 * 1024;

const read = async (blob: Blob): Promise<Uint8Array<ArrayBuffer>> => {
  try {
    return await blob.bytes();
  } catch (cause) {
    // O arquivo sumiu ou mudou no disco desde a escolha.
    throw new PrepareError('unreadable', { cause });
  }
};

/** Tentativas de caber em `IMAGE_LIMITS.bytes`: PNG só encolhe pela dimensão. */
const ATTEMPTS: Record<ImageMediaType, Array<{ side: number; quality?: number }>> = {
  'image/png': [{ side: IMAGE_LIMITS.side }, { side: 1500 }, { side: 1125 }, { side: 850 }],
  'image/jpeg': [
    { side: IMAGE_LIMITS.side, quality: 0.9 },
    { side: IMAGE_LIMITS.side, quality: 0.8 },
    { side: 1500, quality: 0.8 },
    { side: 1125, quality: 0.8 },
    { side: 850, quality: 0.8 },
  ],
};

const draw = (bitmap: ImageBitmap, side: number): OffscreenCanvas => {
  const { width, height } = fitSide(bitmap.width, bitmap.height, side);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
};

const hasTransparency = (canvas: OffscreenCanvas): boolean => {
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    if (data[alpha] !== 255) return true;
  }
  return false;
};

/**
 * Toda imagem passa pelo canvas: aplica a rotação EXIF, deixa os metadados
 * para trás e limita o lado maior. PNG e GIF continuam PNG, como capturas de
 * tela; o resto vira JPEG, a não ser que tenha transparência.
 */
const prepareImage = async (
  file: File,
  id: AttachmentId,
  format: Sniffed,
  head: Uint8Array,
): Promise<AttachmentUpload> => {
  const declared = imageSize(format, head);
  if (declared && declared.width * declared.height > IMAGE_LIMITS.sourcePixels) {
    throw new PrepareError('too_many_pixels');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw new PrepareError(format === 'heic' ? 'heic' : 'undecodable', { cause });
  }

  try {
    if (bitmap.width * bitmap.height > IMAGE_LIMITS.sourcePixels) {
      throw new PrepareError('too_many_pixels');
    }

    // Tentativas no mesmo lado reaproveitam o canvas em vez de redesenhar.
    let drawn: { side: number; canvas: OffscreenCanvas } | null = null;
    const at = (side: number): OffscreenCanvas => {
      if (drawn?.side !== side) drawn = { side, canvas: draw(bitmap, side) };
      return drawn.canvas;
    };

    const keepsPng =
      format === 'png' ||
      format === 'gif' ||
      (format !== 'jpeg' && hasTransparency(at(IMAGE_LIMITS.side)));
    const mediaType: ImageMediaType = keepsPng ? 'image/png' : 'image/jpeg';

    for (const { side, quality } of ATTEMPTS[mediaType]) {
      const canvas = at(side);
      const blob = await canvas.convertToBlob({ type: mediaType, quality });
      if (blob.size > IMAGE_LIMITS.bytes) continue;

      return {
        attachment: {
          id,
          kind: 'image',
          name: renameFor(file.name, mediaType),
          size: blob.size,
          mediaType,
          width: canvas.width,
          height: canvas.height,
        },
        blob,
      };
    }
    throw new PrepareError('image_too_large');
  } finally {
    bitmap.close();
  }
};

const preparePdf = async (file: File, id: AttachmentId): Promise<AttachmentUpload> => {
  if (file.size > MESSAGE_LIMITS.bytes) throw new PrepareError('pdf_too_large');

  const bytes = await read(file);
  const pages = await countPdfPages(bytes);
  return {
    attachment: { id, kind: 'pdf', name: file.name, size: bytes.length, pages },
    blob: new Blob([bytes], { type: 'application/pdf' }),
  };
};

/** Texto é UTF-8 válido e sem NUL; o resto é binário de um tipo que o toi não manda. */
const prepareText = async (file: File, id: AttachmentId): Promise<AttachmentUpload> => {
  if (file.size > TEXT_LIMIT_BYTES) throw new PrepareError('text_too_large');

  const bytes = await read(file);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new PrepareError('unsupported', { cause });
  }
  if (text.includes('\u0000')) throw new PrepareError('unsupported');

  return {
    attachment: { id, kind: 'text', name: file.name, size: bytes.length },
    blob: new Blob([bytes], { type: 'text/plain;charset=utf-8' }),
  };
};

/** Classifica pelos bytes e prepara: imagem pelo canvas, PDF como está, texto validado. */
export const prepareAttachment = async (
  file: File,
  id: AttachmentId,
): Promise<AttachmentUpload> => {
  if (file.size === 0) throw new PrepareError('empty');

  const head = await read(file.slice(0, HEAD_BYTES));
  const format = sniff(head);

  if (format === 'pdf') return preparePdf(file, id);
  if (format !== null) return prepareImage(file, id, format, head);
  return prepareText(file, id);
};
