import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage, extractFile, statFile, uncache } from '@electron/asar';

export function privatePackagePath(file) {
  const name = file.replaceAll('\\', '/');
  const parts = name.split('/');
  const base = parts.at(-1);
  return /\.(?:pfx|p12|key)$/i.test(base)
    || /^\.env(?:$|\.)/i.test(base) && !/\.(?:example|sample|template)$/i.test(base)
    || /^(?:identity|signing)\.local\.json$/i.test(base)
    || /^(?:mcp-oauth\.bin|credentials\.json|connections\.json)$/i.test(base)
    || parts.some(part => /^(?:runtime-state|task-workspaces|conversation-extracts|\.ssh|\.aws|\.azure|\.git)$/i.test(part));
}

export function privateKeyContent(bytes) {
  // Crypto libraries legitimately contain the marker as a parser constant.
  // Require actual base64 key material, including JSON-escaped PEM newlines.
  return [...bytes.toString('utf8').matchAll(/-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/g)]
    .some(match => /^[A-Za-z0-9+/=]{64,}$/.test(match[2].replace(/\s|\\[nr]/g, '')));
}

/** Inspect only the staged package. Error messages contain paths, never secrets. */
export async function auditPackagePrivacy(directory) {
  const failures = new Set();
  let inspected = 0;
  const inspect = (name, read, size) => {
    inspected++;
    if (privatePackagePath(name)) failures.add(name);
    if (size <= 4 * 1024 * 1024 && /\.(?:pem|key|txt|json|js|cjs|mjs|yaml|yml|toml|ini|env)$/i.test(name)) {
      return Promise.resolve(read()).then(bytes => { if (privateKeyContent(bytes)) failures.add(name); });
    }
  };
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(directory, file);
      if (entry.isSymbolicLink()) throw Error('Package privacy audit cannot inspect an unresolved symbolic link: ' + relative);
      if (entry.isDirectory()) {
        if (privatePackagePath(relative)) failures.add(relative);
        await walk(file);
      } else if (entry.isFile()) {
        const { size } = await fs.stat(file);
        await inspect(relative, () => fs.readFile(file), size);
        if (entry.name.endsWith('.asar')) {
          uncache(file);
          for (const member of listPackage(file)) {
            const item = member.replace(/^[\\/]/, '');
            const info = statFile(file, item, false);
            if (info.files) continue;
            if (info.link) throw Error('Package privacy audit cannot inspect an ASAR link: ' + item);
            await inspect(relative + '/' + item, () => extractFile(file, item), info.size);
          }
        }
      }
    }
  }
  await walk(directory);
  if (failures.size) throw Error('Private keys or local user/configuration data must not ship in the application:\n' + [...failures].join('\n'));
  return { inspected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node scripts/audit-package-privacy.mjs <unpacked application directory>');
  auditPackagePrivacy(path.resolve(process.argv[2])).then(result => console.log('Package privacy checks passed:', result.inspected, 'files.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
