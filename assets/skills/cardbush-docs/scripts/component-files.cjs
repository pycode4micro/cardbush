const {extname} = require('node:path');
const {stripTypeScriptTypes} = require('node:module');
const maxBytes = 256 * 1024;

// Input is source text only. Never resolve renderer-provided paths or execute component code in Node.
function assembleComponent(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 64) throw Error('INVALID_COMPONENT');
  let html, total = 0;
  const styles = [], scripts = [];
  for (const file of files) {
    if (typeof file?.name !== 'string' || typeof file.text !== 'string') throw Error('INVALID_COMPONENT');
    total += Buffer.byteLength(file.text);
    if (total > maxBytes) throw Error('COMPONENT_SIZE');
    const extension = extname(file.name).toLowerCase();
    if (['.html','.htm'].includes(extension)) {
      if (html !== undefined) throw Error('MULTIPLE_ENTRIES');
      html = file.text;
    } else if (extension === '.css') {
      styles.push('<style>' + file.text.replace(/<\/style/gi,'<\\/style') + '</style>');
    } else if (['.js','.mjs','.ts','.mts'].includes(extension)) {
      const source = extension.endsWith('ts') ? stripTypeScriptTypes(file.text,{mode:'transform'}) : file.text;
      scripts.push('<script type="module">' + source.replace(/<\/script/gi,'<\\/script') + '</script>');
    } else throw Error('UNSUPPORTED_COMPONENT_FILE');
  }
  const document = [html ?? '<main id="app"></main>',...styles,...scripts].join('\n');
  if (Buffer.byteLength(document) > maxBytes) throw Error('COMPONENT_SIZE');
  return document;
}
module.exports = { assembleComponent };
