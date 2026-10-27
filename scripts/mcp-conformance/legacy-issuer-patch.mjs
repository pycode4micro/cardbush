import { createHash } from 'node:crypto';

export const legacyIssuerPatch = Object.freeze({
  id: 'conformance-0.1.16-legacy-issuer',
  scenario: 'auth/2025-03-26-oauth-metadata-backcompat',
  upstreamSha256: '8af99580e70f26781b379b63c89a90f26c44a9fa82022838d5308ff1a803ef2d',
  sourcePatch: 'patches/mcp-conformance/0.1.16-legacy-issuer.patch',
  description: 'Keep the root issuer while retaining /oauth endpoint routes in the legacy fixture.',
});

export const sha256 = source => createHash('sha256').update(source).digest('hex');
export function verifyOfficialBundle(source) {
  if (sha256(source) !== legacyIssuerPatch.upstreamSha256) {
    throw new Error('Unexpected MCP conformance bundle. Review the fixture correction before upgrading or modifying the suite.');
  }
}

// The npm package ships only a minified bundle. These exact replacements are
// equivalent to the reviewable upstream source diff in sourcePatch. They do not
// touch checks, client code or authorization validation. Fail closed on drift.
export function correctLegacyIssuer(source) {
  verifyOfficialBundle(source);
  const replacements = [
    ['routePrefix:o=``,scopesSupported:s', 'routePrefix:o=``,issuerPath:issuerPath=o,scopesSupported:s'],
    ['issuer:`${t()}${o}`,authorization_endpoint:', 'issuer:`${t()}${issuerPath}`,authorization_endpoint:'],
    ['{loggingEnabled:!1,routePrefix:`/oauth`}', '{loggingEnabled:!1,routePrefix:`/oauth`,issuerPath:``}'],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('MCP conformance fixture patch must match exactly once.');
    source = source.replace(before, after);
  }
  return source;
}
