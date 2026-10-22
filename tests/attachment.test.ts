import { describe, expect, it } from 'vitest';
import { exceededLimit, imageSize, sniff, type Attachment } from '../src/domain/attachment';
import { imageFile, pdfFile, textFile } from './helpers';

const bytes = (...chunks: Array<string | number[]>): Uint8Array =>
  new Uint8Array(
    chunks.flatMap((chunk) =>
      typeof chunk === 'string' ? [...chunk].map((char) => char.charCodeAt(0)) : chunk,
    ),
  );

const u16be = (value: number) => [value >> 8, value & 0xff];
const u32be = (value: number) => [
  value >>> 24,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];
const u32le = (value: number) => [...u32be(value)].reverse();

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const png = (width: number, height: number) =>
  bytes(PNG_SIGNATURE, u32be(13), 'IHDR', u32be(width), u32be(height));

/** SOI, um APP0 qualquer e o SOF0 com as dimensões. */
const jpeg = (width: number, height: number) =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe0, ...u16be(4), 0, 0],
    [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3],
  );

const webp = (chunk: string, body: number[]) =>
  bytes('RIFF', u32le(100), 'WEBP', chunk, u32le(body.length), body);

const attachments = (...items: Array<{ attachment: Attachment }>) =>
  items.map((item) => item.attachment);

describe('sniff', () => {
  it('reconhece o formato pelos bytes, com o PDF depois de lixo no começo', () => {
    expect(sniff(png(1, 1))).toBe('png');
    expect(sniff(jpeg(1, 1))).toBe('jpeg');
    expect(sniff(bytes('BM', u32le(0), u32le(0), u32le(54), u32le(40)))).toBe('bmp');
    expect(sniff(bytes(u32be(24), 'ftypheic'))).toBe('heic');
    expect(sniff(bytes('lixo de e-mail\r\n%PDF-1.4'))).toBe('pdf');
  });

  it('não confunde texto com imagem nem com PDF', () => {
    expect(sniff(bytes('BMW e outros carros, uma lista longa'))).toBeNull();
    expect(sniff(bytes('# notas sobre %PDF-'.padStart(1100, ' ')))).toBeNull();
  });
});

describe('imageSize', () => {
  it('lê as dimensões sem decodificar e desiste do cabeçalho que não fecha', () => {
    expect(imageSize('jpeg', jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    const lossless = (1023 & 0x3fff) | ((767 & 0x3fff) << 14);
    expect(imageSize('webp', webp('VP8L', [0x2f, ...u32le(lossless), 0, 0, 0, 0, 0]))).toEqual({
      width: 1024,
      height: 768,
    });
    expect(imageSize('jpeg', bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });
});

describe('exceededLimit', () => {
  it('uma Mensagem passa dos limites por arquivos, bytes ou páginas', () => {
    expect(exceededLimit(attachments(textFile('a')))).toBeNull();
    expect(
      exceededLimit(Array.from({ length: 21 }, (_, index) => textFile(`a${index}`).attachment)),
    ).toBe('files');
    const heavy = attachments(pdfFile('a', 1, 12_000_000), imageFile('b', 9_000_000));
    expect(exceededLimit(heavy)).toBe('bytes');
    expect(exceededLimit(attachments(pdfFile('a', 60), pdfFile('b', 41)))).toBe('pages');
    // Sem contagem, um PDF ocupa o teto inteiro de páginas.
    expect(exceededLimit(attachments(pdfFile('a', null), pdfFile('b', 1)))).toBe('pages');
  });
});
