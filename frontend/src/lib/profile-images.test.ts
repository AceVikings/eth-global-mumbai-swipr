import { afterEach, expect, it, vi } from 'vitest';
import { botPortrait, prepareProfileImage } from './profile-images';
import { draftFrom, upsertData } from './bots';
import type { BotProfile } from '../contracts/bots';
const image = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==';
afterEach(() => vi.unstubAllGlobals());
it('gives the three test traders distinct portraits and honors uploaded images', () => {
  const defaults = [1, 2, 3].map(n => botPortrait({ name: `Swipr test trader ${n}` }));
  expect(new Set(defaults).size).toBe(3);
  expect(botPortrait({ name: 'My bot', image })).toBe(image);
  expect(botPortrait({ name: 'My bot', image: 'javascript:alert(1)' })).toBe(botPortrait({ name: 'My bot' }));
});
it('keeps an image when editing the rest of a profile and supports removal', () => {
  const profile = { id: 'p', operator: '0x123', name: 'Bot', bio: '', style: 'Balanced', strategy: 'manual', assets: ['WETH'], image } as BotProfile;
  const draft = draftFrom(profile);
  expect(upsertData({ ...draft, name: 'New name' }).image).toBe(image);
  expect(upsertData({ ...draft, image: '' }).image).toBe('');
});
it('rejects unsupported and oversized uploads before decoding', async () => {
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  await expect(prepareProfileImage({ type: 'image/svg+xml', size: 100 } as File)).rejects.toThrow('PNG');
  await expect(prepareProfileImage({ type: 'image/png', size: 6 * 1024 * 1024 } as File)).rejects.toThrow('5 MB');
  expect(decode).not.toHaveBeenCalled();
});
it('center-crops a raster, redraws it as WebP and releases the bitmap', async () => {
  const close = vi.fn(), drawImage = vi.fn(), bitmap = { width: 800, height: 400, close };
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage }), toDataURL: () => image }) });
  expect(await prepareProfileImage({ type: 'image/jpeg', size: 100 } as File)).toBe(image);
  expect(drawImage).toHaveBeenCalledWith(bitmap, 200, 0, 400, 400, 0, 0, 256, 256);
  expect(close).toHaveBeenCalledOnce();
});
