// Render deterministic site icons without contacting sites from UI fixtures.
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const png = readFileSync(resolve(__dirname, '../../assets/plugins/browser/extension/icons/cardbush-32.png'));
exports.fixtureSiteIcon = details => /^https?:/.test(details.url)
  && details.resourceType === 'image' && new URL(details.url).pathname === '/favicon.ico'
  ? {} : undefined;
exports.installFixtureSiteIcons = session => {
  for (const scheme of ['http', 'https']) session.protocol.handle(scheme, request =>
    ['native-only.example.test', 'dead-icon.example.test'].includes(new URL(request.url).hostname)
      ? new Response('Not an icon', { headers: { 'content-type': 'image/png' } })
      : new URL(request.url).pathname === '/favicon.ico'
      ? new Response(png, { headers: { 'content-type': 'image/png' } })
      : new Response('Unexpected fixture request', { status: 400 }));
};
