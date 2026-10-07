// SPDX-License-Identifier: Apache-2.0
const { pathToFileURL } = require('node:url');
const entry = process.env.CARDBUSH_DOCUMENT_TOOLS_ENTRY;
if (!entry) {
  console.error('CardBush document runtime is unavailable on this host. Update the desktop or Agent service.');
  process.exitCode = 1;
} else {
  import(pathToFileURL(entry).href).then(runtime => runtime.startDocumentServer('xlsx'))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
