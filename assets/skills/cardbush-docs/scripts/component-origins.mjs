// Shared by publication, the editor and the capability boundary. Accept an
// exact HTTPS origin, never a URL pattern, credentials, IP literal or port.
export function componentOrigin(value) {
  if (typeof value !== 'string' || value.length > 260 || !/^https:\/\/[a-z0-9.-]+\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
        /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)) return null;
    return url.origin;
  } catch { return null; }
}
export function componentOrigins(value) {
  return Array.isArray(value) && value.length <= 8
    ? [...new Set(value.map(componentOrigin).filter(Boolean))].sort() : [];
}

// A page is usable only while its exact origin remains in the component declaration.
export function approvedWebsiteUrl(value, origins) {
  if (typeof value !== 'string' || value.length > 4096) return;
  const url = URL.parse(value);
  if (url?.protocol === 'https:' && !url.username && !url.password && componentOrigin(url.origin) && origins.includes(url.origin)) return url.href;
}
