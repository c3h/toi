import { describe, expect, it } from 'vitest';
import { prepareAttachment, PrepareError } from '../../src/ui/attachments/prepare';

type Paint = (context: OffscreenCanvasRenderingContext2D) => void;

const canvasOf = (width: number, height: number, paint: Paint) => {
  const canvas = new OffscreenCanvas(width, height);
  paint(canvas.getContext('2d')!);
  return canvas;
};

const solid = (color: string): Paint => (context) => {
  context.fillStyle = color;
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
};

const encode = async (
  width: number,
  height: number,
  type: string,
  paint = solid('#c60'),
): Promise<Uint8Array<ArrayBuffer>> => {
  const blob = await canvasOf(width, height, paint).convertToBlob({ type });
  return new Uint8Array(await blob.arrayBuffer());
};

const fileOf = (bytes: BlobPart, name: string) => new File([bytes], name);

/** Um APP1 EXIF com só a orientação (tag 0x0112): 6 é girar 90° no sentido horário. */
const exifOrientation = (orientation: number): number[] => {
  const tiff = [
    ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08],
    ...[0x00, 0x01],
    ...[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00],
    ...[0x00, 0x00, 0x00, 0x00],
  ];
  const payload = [...new TextEncoder().encode('Exif\0\0'), ...tiff];
  const length = payload.length + 2;
  return [0xff, 0xe1, length >> 8, length & 0xff, ...payload];
};

const withExif = (jpeg: Uint8Array, orientation: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array([...jpeg.slice(0, 2), ...exifOrientation(orientation), ...jpeg.slice(2)]);

const problemOf = async (file: File): Promise<string> => {
  try {
    await prepareAttachment(file, 'a1');
  } catch (error) {
    if (error instanceof PrepareError) return error.problem;
    throw error;
  }
  throw new Error('preparou um arquivo que devia recusar');
};

const containsAscii = async (blob: Blob, text: string): Promise<boolean> =>
  new TextDecoder('latin1').decode(await blob.arrayBuffer()).includes(text);

describe('prepareAttachment: imagem', () => {
  it('aplica a rotação EXIF, reduz o lado maior a 2000 px e não leva os metadados', async () => {
    const jpeg = withExif(await encode(4000, 1000, 'image/jpeg'), 6);

    const { attachment, blob } = await prepareAttachment(fileOf(jpeg, 'foto.jpeg'), 'a1');

    expect(attachment).toMatchObject({
      kind: 'image',
      mediaType: 'image/jpeg',
      name: 'foto.jpg',
      width: 500,
      height: 2000,
    });
    expect(await containsAscii(blob, 'Exif')).toBe(false);
  });

  it('PNG continua PNG; WebP vira PNG só com transparência', async () => {
    const png = await prepareAttachment(
      fileOf(await encode(10, 10, 'image/png'), 'tela.png'),
      'a1',
    );
    expect(png.attachment).toMatchObject({ mediaType: 'image/png', name: 'tela.png' });

    const clear: Paint = (context) => context.clearRect(0, 0, 10, 10);
    const transparent = await encode(10, 10, 'image/webp', clear);
    const alpha = await prepareAttachment(fileOf(transparent, 'logo.webp'), 'a1');
    expect(alpha.attachment).toMatchObject({ mediaType: 'image/png', name: 'logo.png' });

    const opaque = await prepareAttachment(
      fileOf(await encode(10, 10, 'image/webp'), 'foto.webp'),
      'a1',
    );
    expect(opaque.attachment).toMatchObject({ mediaType: 'image/jpeg', name: 'foto.jpg' });
  });

  it('PNG que não cabe em 5 MB de base64 encolhe pela dimensão', async () => {
    const noise: Paint = (context) => {
      const image = context.createImageData(2000, 2000);
      // `getRandomValues` preenche no máximo 64 KB por chamada.
      for (let offset = 0; offset < image.data.length; offset += 65_536) {
        crypto.getRandomValues(image.data.subarray(offset, offset + 65_536));
      }
      for (let alpha = 3; alpha < image.data.length; alpha += 4) image.data[alpha] = 255;
      context.putImageData(image, 0, 0);
    };

    const { attachment, blob } = await prepareAttachment(
      fileOf(await encode(2000, 2000, 'image/png', noise), 'ruido.png'),
      'a1',
    );

    expect(attachment.kind === 'image' && attachment.width).toBeLessThan(2000);
    expect(blob.size).toBeLessThanOrEqual(3_750_000);
    expect(attachment.size).toBe(blob.size);
  });

  it('recusa sem decodificar a imagem com pixels demais', async () => {
    const header = await encode(1, 1, 'image/png');
    const view = new DataView(header.buffer);
    view.setUint32(16, 10_000);
    view.setUint32(20, 10_000);

    expect(await problemOf(fileOf(header, 'gigante.png'))).toBe('too_many_pixels');
  });

  it('diz quando o navegador não abre a imagem', async () => {
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(await problemOf(fileOf(broken, 'quebrada.png'))).toBe('undecodable');

    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]);
    expect(await problemOf(fileOf(heic, 'foto.heic'))).toBe('heic');
  });
});

describe('prepareAttachment: texto', () => {
  it('aceita texto UTF-8 e recusa binário, outra codificação e arquivo vazio', async () => {
    const notes = await prepareAttachment(fileOf('# título\nçã', 'notas.md'), 'a1');
    expect(notes.attachment).toEqual({ id: 'a1', kind: 'text', name: 'notas.md', size: 14 });
    expect(await notes.blob.text()).toBe('# título\nçã');

    expect(await problemOf(fileOf(new Uint8Array([0x6f, 0x6c, 0xe1]), 'latin1.txt'))).toBe(
      'unsupported',
    );
    expect(await problemOf(fileOf('a\u0000b', 'binario.bin'))).toBe('unsupported');
    expect(await problemOf(fileOf('', 'vazio.txt'))).toBe('empty');
  });
});
