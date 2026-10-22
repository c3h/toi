import { describe, expect, it } from 'vitest';
import { countPdfPages } from '../src/ui/attachments/pdf-pages';

const ascii = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array([...text].map((char) => char.charCodeAt(0)));

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const deflate = async (text: string): Promise<Uint8Array> => {
  const stream = new Blob([ascii(text)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const pdf = (body: string) => ascii(`%PDF-1.7\n${body}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);

/** Um PDF cujos dicionários estão todos num object stream comprimido. */
const compressedPdf = async (objects: string, length: 'direct' | 'indirect') => {
  const data = await deflate(objects);
  const size = length === 'direct' ? `${data.length}` : '9 0 R';
  return concat(
    ascii('%PDF-1.7\n4 0 obj\n'),
    ascii(`<< /Type /ObjStm /N 3 /First 12 /Length ${size} /Filter /FlateDecode >>\nstream\n`),
    data,
    ascii(`\nendstream\nendobj\n9 0 obj ${data.length} endobj\n%%EOF\n`),
  );
};

describe('countPdfPages', () => {
  it('lê o /Count da raiz da árvore de páginas', async () => {
    const pages = await countPdfPages(
      pdf(
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [3 0 R 5 0 R] /Count 12 >> endobj\n' +
          '3 0 obj << /Type /Pages /Parent 2 0 R /Count 5 /Resources << /Count 99 >> >> endobj\n' +
          '6 0 obj << /Type /Outlines /Count 40 >> endobj',
      ),
    );

    expect(pages).toBe(12);
  });

  it.each(['direct', 'indirect'] as const)(
    'lê a árvore dentro de object stream com /Length %s',
    async (length) => {
      const objects =
        '1 0 2 40 3 80 << /Type /Catalog /Pages 2 0 R >> ' +
        '<< /Type/Pages/Kids[3 0 R]/Count 7>> << /Type /Page /Parent 2 0 R >>';

      expect(await countPdfPages(await compressedPdf(objects, length))).toBe(7);
    },
  );

  it('sem árvore legível, conta as folhas /Type /Page; sem folhas, devolve null', async () => {
    const pages = await countPdfPages(
      pdf(
        '3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n' +
          '4 0 obj << /Type/Page/Parent 2 0 R >> endobj',
      ),
    );
    expect(pages).toBe(2);

    const encrypted = pdf('1 0 obj << /Filter /Crypt >> stream\nxx\nendstream');
    expect(await countPdfPages(encrypted)).toBeNull();
  });
});
