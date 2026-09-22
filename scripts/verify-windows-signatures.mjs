import { spawnSync } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function collectWindowsBinaries(directory) {
  const files = [];
  async function walk(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error(`Release contains an unresolved link: ${join(root, entry.name)}`);
      const path = join(root, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(exe|dll|node)$/i.test(entry.name)) {
        const handle = await open(path, 'r');
        try {
          const header = Buffer.alloc(2); await handle.read(header, 0, 2, 0);
          if (header.toString('ascii') === 'MZ') files.push(path);
          else if (/\.(exe|dll)$/i.test(entry.name)) throw Error(`Invalid Windows release binary: ${path}`);
          // Cross-platform dependencies can also contain ELF/Mach-O .node files.
        } finally { await handle.close(); }
      }
    }
  }
  await walk(resolve(directory));
  return files.sort();
}

export function requireValidSignatures(files, entries) {
  if (!files.length) throw Error('No Windows binaries were found for release verification.');
  const byPath = new Map(entries.map(entry => [entry.path.toLowerCase(), entry]));
  const failures = files.flatMap(file => {
    const entry = byPath.get(resolve(file).toLowerCase());
    return entry?.status === 'Valid' && entry.keyAlgorithm === '1.2.840.113549.1.1.1'
      ? [] : [`${file}: ${entry?.status ?? 'missing verification'}; ${entry?.keyAlgorithm ?? 'no RSA signing certificate'}`];
  });
  if (failures.length) throw Error(`Windows release signature check failed. Configure a trusted RSA code-signing identity in the publisher build pipeline.\n${failures.join('\n')}`);
  return { verified: files.length };
}

export async function auditWindowsSignatures(files) {
  if (process.platform !== 'win32') throw Error('Windows release signature verification requires a Windows build runner.');
  const paths = files.map(file => resolve(file));
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = @(foreach ($path in $paths) {
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  [pscustomobject]@{path=$path;status=[string]$signature.Status;keyAlgorithm=$signature.SignerCertificate.PublicKey.Oid.Value}
})
ConvertTo-Json -InputObject $results -Compress
`;
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Node can inherit PowerShell 7's modules when launched from pwsh. Those modules
  // are incompatible with the Windows PowerShell 5.1 host used for this audit.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = join(dirname(shell), 'Modules');
  const response = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(paths), env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  if (response.error) throw response.error;
  if (response.status !== 0) throw Error(response.stderr || 'Windows signature verification failed.');
  const result = requireValidSignatures(paths, JSON.parse(response.stdout.replace(/^\uFEFF/, '')));
  console.log(`Verified Windows-trusted RSA signatures for ${result.verified} Windows binaries.`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) { console.error('Usage: node scripts/verify-windows-signatures.mjs <unpacked Windows application directory>'); process.exitCode = 1; }
  else collectWindowsBinaries(directory).then(auditWindowsSignatures).catch(error => { console.error(error.message); process.exitCode = 1; });
}
