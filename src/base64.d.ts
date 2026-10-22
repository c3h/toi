/**
 * `Uint8Array.prototype.toBase64` é Baseline desde 2025 (Chrome 140, Firefox
 * 133, Safari 18.2), mas o TypeScript 5.9 ainda não a tipa. Sai quando a lib
 * do TypeScript trouxer a declaração.
 */
interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
  toBase64(options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }): string;
}
