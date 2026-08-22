export function localFileSystemPathFromProtocolUrl(
  value: string,
  platform: NodeJS.Platform = process.platform,
) {
  const parsed = new URL(value);
  const hostname = decodeURIComponent(parsed.hostname);
  const pathname = decodeURIComponent(parsed.pathname);

  if (platform !== 'win32') {
    return hostname ? `//${hostname}${pathname}` : pathname;
  }

  // Chromium may canonicalize a legacy Windows resource URL such as
  // cardbush-file://C:/Users/... to cardbush-file://c/Users/.... A single
  // letter host is therefore a drive designator, not an UNC server name.
  if (/^[a-z]$/i.test(hostname)) {
    return `${hostname.toUpperCase()}:${windowsPathname(pathname)}`;
  }

  if (hostname) {
    return `\\\\${hostname}${windowsPathname(pathname)}`;
  }

  return pathname
    .replace(/^\/+([a-zA-Z]:)/, '$1')
    .replace(/\//g, '\\');
}

function windowsPathname(value: string) {
  const normalized = value.replace(/\//g, '\\');
  return normalized.startsWith('\\') ? normalized : `\\${normalized}`;
}
