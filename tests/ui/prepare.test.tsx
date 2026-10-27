import { describe, expect, it } from 'vitest';
import { prepareAttachment } from '../../src/ui/attachments/prepare';

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
});
