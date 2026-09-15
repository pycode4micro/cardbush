import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as ResEdit from 'resedit';

const executablePath = path.resolve(process.argv[2]);
const executable = ResEdit.NtExecutable.from(fs.readFileSync(executablePath), {ignoreCert:true});
const resources = ResEdit.NtExecutableResource.from(executable);
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
const expected = ResEdit.Data.IconFile.from(fs.readFileSync('assets/cardbush.ico'));
const digest = icon => createHash('sha256').update(Buffer.from(icon.isRaw() ? icon.bin : icon.generate())).digest('hex');
const canonical = expected.icons.map(icon => digest(icon.data)).sort();
assert.ok(groups.length, 'The executable must contain native Windows icons.');
for (const group of groups) {
  assert.deepEqual(group.getIconItemsFromEntries(resources.entries).map(digest).sort(), canonical,
    'Every executable icon group must contain the multi-resolution CardBush logo.');
}
console.log(`Windows executable branding passed (${groups.length} icon groups, ${canonical.length} sizes each).`);
