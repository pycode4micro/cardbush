import { componentOrigins } from '../../../assets/skills/cardbush-docs/scripts/component-origins.mjs';
import type { HtmlComponent } from './componentModel';

export function approvedOrigins(item: HtmlComponent) {
  const requested = componentOrigins(item.networkDomains);
  return componentOrigins(item.approvedNetworkOrigins).filter(origin => requested.includes(origin));
}

/** Components get JSON from a user-approved site, never a general host fetch or cookies. */
export async function fetchComponentJson(input: unknown, origins: string[], signal: AbortSignal) {
  if (typeof input !== 'string' || input.length > 4096) throw Error('INVALID_URL');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || !origins.includes(url.origin)) throw Error('CAPABILITY_DENIED');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, {once:true});
  const timeout = setTimeout(abort, 15000);
  try {
    const response = await fetch(url, {method:'GET', mode:'cors', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer',
      cache:'no-store', headers:{Accept:'application/json'}, signal:controller.signal});
    if (!response.ok) throw Error('HTTP_' + response.status);
    if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw Error('EXPECTED_JSON');
    const reader = response.body?.getReader();
    if (!reader) throw Error('EMPTY_RESPONSE');
    const decoder = new TextDecoder(); let text = '', bytes = 0;
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw Error('RESPONSE_LIMIT');
      text += decoder.decode(value, {stream:true});
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { abort(); clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}
