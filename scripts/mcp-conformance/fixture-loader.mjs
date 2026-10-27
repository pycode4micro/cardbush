import { registerHooks } from 'node:module';
import { correctLegacyIssuer, legacyIssuerPatch } from './legacy-issuer-patch.mjs';

// Loaded explicitly only in the official runner process for the affected case.
// Keep original module URLs so the suite resolves its own dependency versions.
// Nothing is written to node_modules or injected into the CardBush client.
const target = new URL('../../node_modules/@modelcontextprotocol/conformance/dist/index.js', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== target) return result;
    if (result.format !== 'module' || result.source == null) throw new Error('Unexpected conformance module format.');
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    const corrected = correctLegacyIssuer(source);
    process.stderr.write(`[CardBush fixture correction] ${legacyIssuerPatch.id}\n`);
    return { ...result, source: corrected };
  },
});
