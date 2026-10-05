import { useSyncExternalStore } from 'react';

const key = 'cardbush_personal_assistant_avatar_v1', eventName = 'cardbush:assistant-avatar';
const valid = (value: string) => value.length <= 360000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
export function readAssistantAvatar() {
  try { const value = localStorage.getItem(key) ?? ''; return valid(value) ? value : ''; }
  catch { return ''; }
}
export function saveAssistantAvatar(value: string) {
  if (value && !valid(value)) throw Error('INVALID_AVATAR');
  if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  window.dispatchEvent(new Event(eventName));
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === key) listener(); };
  window.addEventListener(eventName, listener); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener('storage', storage); };
}
export const useAssistantAvatar = () => useSyncExternalStore(subscribe, readAssistantAvatar);

/** Store a small, decoded raster copy, independent of the source file's lifetime. */
export async function prepareAssistantAvatar(file: File, language: 'zh' | 'en') {
  const zh = language === 'zh';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error(zh ? '请选择 PNG、JPG 或 WebP 图片。' : 'Choose a PNG, JPG or WebP image.');
  if (file.size > 8 * 1024 * 1024) throw Error(zh ? '图片不能超过 8 MB。' : 'Choose an image smaller than 8 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    try { await image.decode(); } catch { throw Error(zh ? '无法读取这张图片，请换一张重试。' : 'This image could not be read. Try another image.'); }
    if (!image.naturalWidth || !image.naturalHeight) throw Error(zh ? '图片尺寸无效。' : 'Invalid image dimensions.');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw Error(zh ? '无法处理头像，请重试。' : 'Unable to prepare the avatar. Try again.');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL('image/webp', .9);
  } finally { URL.revokeObjectURL(url); }
}
