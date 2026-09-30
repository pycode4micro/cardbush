const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// Electron insertCSS and source contracts must see the same ordered stylesheet
// as Vite. Other source files retain readFileSync's ordinary behavior.
function readSourceFile(file, options, ancestors = []) {
  const filename = file instanceof URL ? fileURLToPath(file) : file;
  const contents = fs.readFileSync(file, options);
  if (typeof filename !== 'string' || path.extname(filename) !== '.css' || typeof contents !== 'string') return contents;
  const resolved = path.resolve(filename);
  if (ancestors.includes(resolved)) throw new Error(`Circular stylesheet import: ${resolved}`);
  return contents.replace(/^@import\s+["']([^"']+)["'];\s*$/gm, (_match, target) => {
    if (!target.startsWith('.')) throw new Error(`Expected a local stylesheet import: ${target}`);
    return readSourceFile(path.resolve(path.dirname(resolved), target), options, [...ancestors, resolved]);
  });
}

module.exports = { readSourceFile };
