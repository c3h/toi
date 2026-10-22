import type { AttachmentId } from './ids';

/**
 * Um arquivo anexado a uma Mensagem do user, já preparado. A Parte guarda só
 * estes metadados; os bytes ficam no store `attachments`, por `id`. Imagem sai
 * sempre do canvas, então só existe em PNG ou JPEG.
 */
export type Attachment =
  | {
      id: AttachmentId;
      kind: 'image';
      name: string;
      size: number;
      mediaType: ImageMediaType;
      width: number;
      height: number;
    }
  /** `pages` é `null` quando a contagem nos bytes não acha a árvore de páginas. */
  | { id: AttachmentId; kind: 'pdf'; name: string; size: number; pages: number | null }
  | { id: AttachmentId; kind: 'text'; name: string; size: number };

export type ImageMediaType = 'image/png' | 'image/jpeg';

/** Um Anexo pronto para gravar: os metadados e os bytes. */
export interface AttachmentUpload {
  attachment: Attachment;
  blob: Blob;
}

const MB = 1_000_000;

/**
 * Limites de uma Mensagem, valham para qualquer Modelo. Os bytes de uma
 * Mensagem em base64 (×4/3, 26,7 MB) cabem no orçamento da requisição, e as
 * páginas no menor teto de páginas da API: o turno atual sempre cabe.
 */
export const MESSAGE_LIMITS = {
  files: 20,
  bytes: 20 * MB,
  pages: 100,
} as const;

/** Uma imagem preparada: o lado maior e os bytes que a API aceita sem reduzir. */
export const IMAGE_LIMITS = {
  side: 2000,
  /** 5 MB em base64. */
  bytes: 3.75 * MB,
  /** Pixels decodificados antes de reduzir; acima disso a aba pode ficar sem memória. */
  sourcePixels: 50_000_000,
} as const;

/** Texto acima disso passa do contexto de qualquer Modelo (~850 mil tokens). */
export const TEXT_LIMIT_BYTES = 3 * MB;

/**
 * Tetos de uma requisição à API. Páginas e blocos de imagem ou documento
 * sobem com o contexto de 1 milhão de tokens; `bytes` deixa folga até os 32 MB
 * para o texto em JSON.
 */
export interface RequestLimits {
  bytes: number;
  pages: number;
  files: number;
}

const LARGE_CONTEXT = 1_000_000;

export const requestLimits = (maxInputTokens: number): RequestLimits => {
  const large = maxInputTokens >= LARGE_CONTEXT;
  return { bytes: 28 * MB, pages: large ? 600 : 100, files: large ? 600 : 100 };
};

/** Páginas que um PDF ocupa no teto; sem contagem, ocupa o teto de uma Mensagem. */
export const pagesOf = (attachment: Attachment): number =>
  attachment.kind === 'pdf' ? (attachment.pages ?? MESSAGE_LIMITS.pages) : 0;

/** Bytes na requisição: imagem e PDF vão em base64, texto vai como texto. */
export const requestBytesOf = (attachment: Attachment): number =>
  attachment.kind === 'text' ? attachment.size : Math.ceil(attachment.size / 3) * 4;

export type MessageLimit = 'files' | 'bytes' | 'pages';

/** O primeiro limite de `MESSAGE_LIMITS` que os Anexos de uma Mensagem passam, ou `null`. */
export const exceededLimit = (attachments: Attachment[]): MessageLimit | null => {
  if (attachments.length > MESSAGE_LIMITS.files) return 'files';
  if (attachments.reduce((sum, item) => sum + item.size, 0) > MESSAGE_LIMITS.bytes) return 'bytes';
  const pages = attachments.reduce((sum, item) => sum + pagesOf(item), 0);
  return pages > MESSAGE_LIMITS.pages ? 'pages' : null;
};

/** Formato reconhecido pelos primeiros bytes, nunca pela extensão. */
export type Sniffed = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'heic' | 'avif' | 'pdf';

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

/** Tamanhos do cabeçalho DIB: só "BM" confundiria um texto que começa assim. */
const BMP_HEADERS = new Set([12, 40, 52, 56, 64, 108, 124]);

const isBmp = (bytes: Uint8Array): boolean =>
  startsWith(bytes, ascii('BM')) &&
  bytes.length >= 18 &&
  BMP_HEADERS.has(new DataView(bytes.buffer, bytes.byteOffset).getUint32(14, true));

/** O PDF pode ter lixo antes do cabeçalho; os leitores procuram no primeiro KB. */
const PDF_HEADER_WINDOW = 1024;

export const sniff = (bytes: Uint8Array): Sniffed | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  if (isBmp(bytes)) return 'bmp';

  if (startsWith(bytes, ascii('ftyp'), 4)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (HEIC_BRANDS.has(brand)) return 'heic';
  }

  const pdf = ascii('%PDF-');
  const last = Math.min(bytes.length, PDF_HEADER_WINDOW) - pdf.length;
  for (let offset = 0; offset <= last; offset += 1) {
    if (startsWith(bytes, pdf, offset)) return 'pdf';
  }

  return null;
};

/** Marcadores SOF do JPEG que carregam as dimensões (exceto DHT, JPG e DAC). */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

type Size = { width: number; height: number };

const jpegSize = (view: DataView): Size | null => {
  let offset = 2;
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (isStartOfFrame(marker)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
};

const uint24 = (view: DataView, offset: number): number =>
  view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);

const webpSize = (view: DataView): Size | null => {
  const chunk = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + 12, 4));
  if (chunk === 'VP8X') return { width: uint24(view, 24) + 1, height: uint24(view, 27) + 1 };
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return null;
};

/** Bytes mínimos do cabeçalho de cada formato para ler as dimensões. */
const HEADER_BYTES: Partial<Record<Sniffed, number>> = { png: 24, gif: 10, bmp: 26, webp: 30 };

/**
 * Dimensões lidas do cabeçalho, sem decodificar, para recusar uma imagem que
 * estouraria a memória antes de o navegador abri-la. `null` quando o formato
 * não deixa ler barato (HEIC, AVIF) ou o cabeçalho não fecha.
 */
export const imageSize = (format: Sniffed, bytes: Uint8Array): Size | null => {
  if (bytes.length < (HEADER_BYTES[format] ?? 0)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (format) {
    case 'png':
      return { width: view.getUint32(16), height: view.getUint32(20) };
    case 'gif':
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    case 'bmp':
      // Altura negativa marca as linhas de cima para baixo.
      return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
    case 'jpeg':
      return jpegSize(view);
    case 'webp':
      return webpSize(view);
    case 'heic':
    case 'avif':
    case 'pdf':
      return null;
  }
};

/** O tamanho que a imagem preparada pode ter: o lado maior em `side`, sem ampliar. */
export const fitSide = (width: number, height: number, side: number): Size => {
  const scale = Math.min(1, side / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/** O nome com a extensão do formato em que a imagem foi gravada. */
export const renameFor = (name: string, mediaType: ImageMediaType): string => {
  const extension = mediaType === 'image/png' ? '.png' : '.jpg';
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base || 'imagem'}${extension}`;
};
