// Shared by the Home renderer and Electron before a website guest attaches.
export const homeWebsitePartitionPrefix = 'cardbush-home-site:';

export function websiteAddress(text: string) {
  try {
    const url = new URL(text);
    if (url.username || url.password) return;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) return url.href;
  } catch { /* The form keeps incomplete addresses editable. */ }
}
