// DrawingML shape definitions, vendored from Apache POI (Apache-2.0).
// Regeneration is explicit; builds and previews never download geometry data.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';

const revision = '338882ac8898df5c13a7d15f533204c5dd8607d6';
const source = `https://raw.githubusercontent.com/apache/poi/${revision}/poi/src/main/resources/org/apache/poi/sl/draw/geom/presetShapeDefinitions.xml`;
const xml = process.argv[2] ? await readFile(process.argv[2], 'utf8') : await (await fetch(source)).text();
const document = new DOMParser().parseFromString(xml, 'application/xml');
if (document.documentElement.localName !== 'presetShapeDefinitons') throw Error('Invalid preset catalog');
const children = node => Array.from(node.childNodes).filter(child => child.nodeType === 1);
const attrs = node => Object.fromEntries(Array.from(node.attributes).map(attr => [attr.name, attr.value]));
const child = (node, name) => children(node).find(item => item.localName === name);
const guides = node => node ? children(node).map(item => [item.getAttribute('name'), item.getAttribute('fmla')]) : [];
const presets = {};
for (const shape of children(document.documentElement)) {
  presets[shape.localName] = {
    adjustments: guides(child(shape, 'avLst')),
    guides: guides(child(shape, 'gdLst')),
    paths: children(child(shape, 'pathLst')).map(path => ({ ...attrs(path), commands: children(path).map(command => ({
      kind: command.localName, ...attrs(command), points: children(command).map(attrs),
    })) })),
  };
}
await mkdir('src/office', { recursive: true });
await writeFile('src/office/presetShapes.json', `{"source":${JSON.stringify(source)},"sha256":${JSON.stringify(createHash('sha256').update(xml).digest('hex'))},"presets":{\n` +
  Object.entries(presets).map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(',\n') + '\n}}\n');
console.log(`Generated ${Object.keys(presets).length} DrawingML presets.`);
