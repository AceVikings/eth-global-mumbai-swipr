// New media lives on Swarm; retain inline thumbnails from existing Arkiv profiles.
export const MAX_PROFILE_IMAGE_BYTES = 8 * 1024;
export function profileImage(value: unknown): string {
  if (value === '') return '';
  if (typeof value === 'string' && /^bzz:\/\/[0-9a-f]{64}$/.test(value)) return value;
  if (typeof value !== 'string' || value.length > 10947 || !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Choose a WebP thumbnail up to 8 KB.');
  }
  let bytes: string;
  try { bytes = atob(value.slice(23)); } catch { throw new Error('Image data is invalid.'); }
  if (bytes.length < 20 || bytes.length > MAX_PROFILE_IMAGE_BYTES || bytes.slice(0, 4) !== 'RIFF' || bytes.slice(8, 12) !== 'WEBP'
    || !['VP8 ', 'VP8L', 'VP8X'].includes(bytes.slice(12, 16))) throw new Error('Image data is not a WebP thumbnail.');
  return value;
}
