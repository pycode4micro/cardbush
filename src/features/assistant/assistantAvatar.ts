import { uiText } from '../../i18n';
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
export async function prepareAssistantAvatar(file: File, language: string) {

  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error(uiText(language)('assistantAvatar.chooseAPngJpgOrWebpImage'));
  if (file.size > 8 * 1024 * 1024) throw Error(uiText(language)('assistantAvatar.chooseAnImageSmallerThan8Mb'));
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    try { await image.decode(); } catch { throw Error(uiText(language)('assistantAvatar.thisImageCouldNotBeReadTry')); }
    if (!image.naturalWidth || !image.naturalHeight) throw Error(uiText(language)('assistantAvatar.invalidImageDimensions'));
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw Error(uiText(language)('assistantAvatar.unableToPrepareTheAvatarTryAgain'));
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL('image/webp', .9);
  } finally { URL.revokeObjectURL(url); }
}
