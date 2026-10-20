// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';
import { elements, part } from './files.mjs';

const drawingNamespaces = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main']);
const relationshipNamespaces = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']);
const enums = {
  tcPr: { anchor: ['t', 'ctr', 'b', 'just', 'dist'], vert: ['horz', 'vert', 'vert270', 'wordArtVert', 'eaVert', 'mongolianVert', 'wordArtVertRtl'] },
  bodyPr: { anchor: ['t', 'ctr', 'b', 'just', 'dist'], wrap: ['none', 'square'] },
  pPr: { algn: ['l', 'ctr', 'r', 'just', 'justLow', 'dist', 'thaiDist'] },
};
const invalid = (member, detail) => { throw new Error(`Invalid PPTX (${member}): ${detail}`); };

/** Targeted package/semantic checks, not a claim of full OOXML or visual validation. */
export async function validatePresentation(zip) {
  const relationships = new Map();
  for (const member of Object.keys(zip.files).filter(name => name.endsWith('.rels'))) {
    const source = member === '_rels/.rels' ? '' : member.replace('/_rels/', '/').slice(0, -5);
    const ids = new Set();
    for (const rel of elements(await part(zip, member), 'Relationship')) {
      const id = rel.getAttribute('Id'), target = rel.getAttribute('Target');
      if (!id || !target || ids.has(id)) invalid(member, 'missing/duplicate relationship ID or missing target.');
      ids.add(id);
      if (rel.getAttribute('TargetMode') === 'External') continue;
      let path;
      try { path = decodeURIComponent(target.split('#')[0]); }
      catch { invalid(member, `malformed target for ${id}.`); }
      const resolved = posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(source), path));
      if (resolved === '..' || resolved.startsWith('../') || !zip.file(resolved)) invalid(member, `${id} references a missing part: ${resolved}`);
    }
    relationships.set(source, ids);
  }
  let checkedParts = 0, tables = 0, charts = 0;
  for (const member of Object.keys(zip.files).filter(name => /^ppt\/.*\.xml$/.test(name))) {
    const doc = await part(zip, member); checkedParts++;
    for (const node of elements(doc, '*')) {
      if (drawingNamespaces.has(node.namespaceURI)) {
        if (node.localName === 'tbl') tables++;
        for (const [attribute, allowed] of Object.entries(enums[node.localName] ?? {})) {
          if (!node.hasAttribute(attribute)) continue;
          const value = node.getAttribute(attribute);
          if (!allowed.includes(value)) invalid(member, `${node.tagName}@${attribute}="${value}"; expected ${allowed.join(', ')}.${attribute === 'anchor' ? ' In PptxGenJS use valign: "top", "middle" or "bottom" (not "mid").' : ''}`);
        }
      }
      if (node.localName === 'chart' && /\/chart$/.test(node.namespaceURI ?? '')) charts++;
      for (const attr of [...node.attributes]) {
        if (relationshipNamespaces.has(attr.namespaceURI) && ['id', 'embed', 'link'].includes(attr.localName) &&
          !relationships.get(member)?.has(attr.value)) invalid(member, `${node.tagName}@${attr.name} references unknown relationship ${attr.value}.`);
      }
    }
  }
  return { checkedParts, tables, charts, checks: ['xml', 'internal_relationships', 'drawingml_alignment'], fullSchemaValidation: false };
}
