require('node:fs').writeFileSync(require('node:path').join(__dirname, '../dist-cjs/package.json'), '{"type":"commonjs"}\n');
