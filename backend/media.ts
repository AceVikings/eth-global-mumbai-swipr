import { ApiError } from './auth';
import { MAX_PROFILE_IMAGE_BYTES, profileImage } from './contracts/profile-image';
import type { BeeClient } from './providers/bee';

/** Only static, bounded WebP portraits are served by the public media endpoint. */
export function checkPortrait(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  const invalid = () => { throw new ApiError(400, 'invalid_image', 'Choose a static WebP portrait up to 256 pixels.'); };
  if (b.length < 25 || b.length > MAX_PROFILE_IMAGE_BYTES || b.toString('ascii', 0, 4) !== 'RIFF'
    || b.toString('ascii', 8, 12) !== 'WEBP' || b.readUInt32LE(4) + 8 !== b.length) invalid();
  let offset = 12, frames = 0;
  while (offset < b.length) {
    if (offset + 8 > b.length) invalid();
    const type = b.toString('ascii', offset, offset + 4), length = b.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > b.length || !['VP8 ', 'VP8L', 'VP8X', 'ALPH'].includes(type)) invalid();
    let width = 0, height = 0;
    if (type === 'VP8 ') {
      if (length < 10 || b.subarray(start + 3, start + 6).toString('hex') !== '9d012a' || b[start] & 1) invalid();
      width = b.readUInt16LE(start + 6) & 0x3fff; height = b.readUInt16LE(start + 8) & 0x3fff; frames++;
    } else if (type === 'VP8L') {
      if (length < 5 || b[start] !== 0x2f || b[start + 4] >> 5) invalid();
      const bits = b.readUInt32LE(start + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; frames++;
    } else if (type === 'VP8X') {
      if (length !== 10 || b[start] & ~0x10) invalid(); // Alpha only: no metadata or animation.
      width = b.readUIntLE(start + 4, 3) + 1; height = b.readUIntLE(start + 7, 3) + 1;
    }
    if (type !== 'ALPH' && (!width || !height || width > 256 || height > 256)) invalid();
    offset = start + length + (length % 2);
  }
  if (offset !== b.length || frames !== 1) invalid();
}

export function createMedia(bee: BeeClient) {
  return {
    async upload(image: unknown) {
      let validated: string;
      try { validated = profileImage(image); } catch { throw new ApiError(400, 'invalid_image', 'Choose a WebP thumbnail up to 8 KB.'); }
      if (!validated.startsWith('data:')) throw new ApiError(400, 'invalid_image', 'Choose an image to upload.');
      const bytes = Buffer.from(validated.slice(23), 'base64');
      checkPortrait(bytes);
      const uploaded = await bee.upload(bytes, 'image/webp');
      // A successful write response alone does not prove the media can be retrieved.
      const retrieved = await bee.download(uploaded.ref);
      checkPortrait(retrieved.bytes);
      return { image: `bzz://${uploaded.ref}`, reference: uploaded.ref, size: bytes.length, bmt: retrieved.bmt };
    },
    async read(ref: string) {
      const result = await bee.download(ref);
      checkPortrait(result.bytes);
      return result;
    },
  };
}
export type MediaService = ReturnType<typeof createMedia>;
