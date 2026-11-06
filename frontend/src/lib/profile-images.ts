import { apiBase } from './bots';
import type { Session } from '../auth/Session';
import violet from '../assets/bots/bot-1.svg';
import sage from '../assets/bots/bot-2.svg';
import coral from '../assets/bots/bot-3.svg';
import { MAX_PROFILE_IMAGE_BYTES, profileImage } from '../contracts/profile-image';

const portraits = [violet, sage, coral];
export function botPortrait(profile: { id?: string; name: string; image?: string }): string {
  if (profile.image) {
    try { const image = profileImage(profile.image); return image.startsWith('bzz://') ? `${apiBase}/api/media/${image.slice(6)}` : image; } catch { /* Invalid public data uses an illustration. */ }
  }
  const testNumber = /^Swipr test trader ([123])$/.exec(profile.name)?.[1];
  const hash = [...(profile.id || profile.name)].reduce((n, char) => (n * 31 + char.charCodeAt(0)) >>> 0, 0);
  return portraits[testNumber ? Number(testNumber) - 1 : hash % portraits.length];
}

/** Decode and redraw raster inputs: metadata is discarded and only a small square is stored. */
export async function prepareProfileImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MB.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('This image could not be opened. Try another file.'); }
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Choose an image smaller than 40 megapixels.');
    const edge = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context || !edge) throw new Error('Image editing is unavailable in this browser.');
    for (const size of [256, 192, 128]) {
      canvas.width = canvas.height = size;
      context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, size, size);
      const data = canvas.toDataURL('image/webp', 0.78);
      if (data.length <= 23 + Math.ceil(MAX_PROFILE_IMAGE_BYTES / 3) * 4) return profileImage(data);
    }
    throw new Error('This image is too detailed. Choose a simpler image.');
  } finally { bitmap.close(); }
}

/** The Arkiv profile contains only the Swarm reference after a verified upload. */
export async function uploadProfileImage(session: Session, file: File): Promise<string> {
  const image = await prepareProfileImage(file);
  const token = await session.getAccessToken();
  if (!token || !session.address) throw new Error('Sign in to upload an image.');
  const response = await fetch(`${apiBase}/api/media`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ image, wallet: session.address }) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || 'Image upload failed. Try again.');
  if (result?.bmt !== 'verified' || typeof result?.image !== 'string' || !/^bzz:\/\/[0-9a-f]{64}$/.test(result.image)) {
    throw new Error('The uploaded image could not be verified.');
  }
  return profileImage(result.image);
}
