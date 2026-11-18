import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';

const root = resolve('deploy/web/plugins/volcengine_images/volcengine_plugins/assets/layers');
const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
let document: Promise<{ html: string; policy: string }> | undefined;

async function load() {
  const [html, css, js, en, zh] = await Promise.all(
    ['editor.html', 'editor.css', 'editor.js', 'locales/en.json', 'locales/zh.json']
      .map(name => readFile(resolve(root, name), 'utf8')),
  );
  // CSP hashes cover the inline contents as parsed by the browser.
  const script = js.replace(/\r\n?/g, '\n');
  const catalogs = JSON.stringify({ en: JSON.parse(en), zh: JSON.parse(zh) }).replace(/</g, '\\u003c');
  const policy = `sandbox allow-scripts; default-src 'none'; script-src ${sha256(script)} ${sha256(catalogs)}; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`;
  return { policy, html: html.replace('<html lang="en">', '<html lang="en" data-host="web">')
    .replace('/*__STYLES__*/', () => css).replace('/*__CATALOGS__*/', () => catalogs).replace('/*__SCRIPT__*/', () => script) };
}

export async function serveLayerEditor(response: ServerResponse) {
  const result = await (document ??= load().catch(error => { document = undefined; throw error; }));
  response.removeHeader('X-Frame-Options');
  response.setHeader('Content-Security-Policy', result.policy);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(result.html);
}
