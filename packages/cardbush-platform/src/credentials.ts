// Node-only entry point, shared by Electron and the standalone CLI. The public
// subpath deliberately resolves to the CommonJS build in both hosts.
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const prefix = 'cardbush-secret:v1:';
const decoded = new Map<string, string>();
const encoded = new Map<string, string>();
const sensitive = /token|secret|password|passwd|passphrase|authorization|cookie|(?:api|access|private|subscription)[_-]?key/i;
const containers = /^(?:env|environment|headers|defaultHeaders|default_headers|args)$/i;
function failure(code: string): never { throw Object.assign(new Error(code), { code }); }
function remember(plain: string, sealed: string) {
  if (decoded.size >= 256) { decoded.clear(); encoded.clear(); }
  decoded.set(sealed, plain); encoded.set(plain, sealed);
}

let nativeHost: string | undefined;
export function credentialNativeHost(): string {
  if (nativeHost) return nativeHost;
  // Never resolve helpers from cwd, PATH, a plugin, or user configuration.
  for (let root = __dirname; ; root = path.dirname(root)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'cardbush') {
        const candidate = root.endsWith('.asar') ? path.join(path.dirname(root), 'chrome-native-host', 'CardBushBrowserHost.exe')
          : path.join(root, 'dist-native', 'chrome-connector', 'CardBushBrowserHost.exe');
        if (fs.statSync(candidate).isFile()) return nativeHost = candidate;
      }
    } catch { /* Continue through trusted module ancestors. */ }
    if (path.dirname(root) === root) return failure('credential_host_unavailable');
  }
}

function externalKey(): Buffer {
  // Headless Unix has no guaranteed desktop keyring. An operator may supply a
  // separately managed 32-byte key, never an adjacent auto-generated sidecar.
  const file = process.env.CARDBUSH_CREDENTIAL_KEY_FILE;
  const managed = process.env.CARDBUSH_CREDENTIAL_KEY;
  if (managed) {
    if (file || !/^[a-f0-9]{64}$/i.test(managed)) return failure('credential_key_invalid');
    return Buffer.from(managed, 'hex');
  }
  if (!file || !path.isAbsolute(file)) return failure('credential_key_file_required');
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 32
      || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) return failure('credential_key_file_not_private');
    return fs.readFileSync(file);
  } catch { return failure('credential_key_file_unavailable_or_not_private'); }
}

export function protectSecret(value: string): string {
  if (!value) return value;
  if (value.startsWith(prefix)) { unprotectSecret(value); return value; }
  const cached = encoded.get(value); if (cached) return cached;
  let sealed: string;
  if (process.platform === 'win32') {
    try {
      sealed = prefix + 'dpapi:' + execFileSync(credentialNativeHost(), ['--protect-secret'], {
        input: Buffer.from(value).toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      }).trim();
    } catch { return failure('credential_protection_failed'); }
  } else {
    const key = externalKey(), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    try { sealed = prefix + 'external:' + Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64'); }
    finally { key.fill(0); }
  }
  remember(value, sealed); return sealed;
}

export function unprotectSecret(value: string): string {
  if (!value.startsWith(prefix)) return value;
  const cached = decoded.get(value); if (cached !== undefined) return cached;
  const payload = value.slice(prefix.length);
  let plain: string;
  try {
    if (payload.startsWith('dpapi:') && process.platform === 'win32') {
      plain = Buffer.from(execFileSync(credentialNativeHost(), ['--unprotect-secret'], {
        input: payload.slice(6), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      }).trim(), 'base64').toString('utf8');
    } else if (payload.startsWith('external:')) {
      const key = externalKey(), bytes = Buffer.from(payload.slice(9), 'base64');
      try {
        if (bytes.length < 28) return failure('credential_decryption_failed');
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
        plain = Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
      } finally { key.fill(0); }
    } else return failure('credential_protection_backend_mismatch');
  } catch { return failure('credential_decryption_failed'); }
  remember(plain, value); return plain;
}

/** Preserve configuration shape, including templates. Only host readers decode
 * values; the on-disk file never becomes a transport/export payload. */
export function protectConfiguration<T>(value: T): T {
  const visit = (item: unknown, protect = false): unknown => {
    if (typeof item === 'string') {
      let credentialUrl = false;
      try { const url = new URL(item); credentialUrl = Boolean(url.username || url.password || [...url.searchParams.keys()].some(key => sensitive.test(key))); } catch { /* Ordinary value. */ }
      return protect || credentialUrl ? protectSecret(item) : item;
    }
    if (Array.isArray(item)) return item.map(child => visit(child, protect));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) =>
      [key, visit(child, protect || sensitive.test(key) || containers.test(key))]));
    return item;
  };
  return visit(value) as T;
}
export function unprotectConfiguration<T>(value: T): T {
  if (typeof value === 'string') return unprotectSecret(value) as T;
  if (Array.isArray(value)) return value.map(unprotectConfiguration) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unprotectConfiguration(child)])) as T;
  return value;
}

export function assertPrivateConfigFile(file: string) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) failure('credential_config_redirected');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export function secureConfigDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) failure('credential_config_redirected');
  if (process.platform === 'win32') {
    try { execFileSync(credentialNativeHost(), ['--secure-credential-directory', directory], { windowsHide: true, timeout: 10000, stdio: 'pipe' }); }
    catch { failure('credential_directory_protection_failed'); }
  } else {
    const keyFile = process.env.CARDBUSH_CREDENTIAL_KEY_FILE;
    if (keyFile) {
      let profile = fs.realpathSync(directory);
      if (['config', 'workers', 'browser-connector'].includes(path.basename(profile))) profile = path.dirname(profile);
      if (path.basename(profile) === 'product-host') profile = path.dirname(profile);
      const relative = path.relative(profile, fs.realpathSync(keyFile));
      if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) failure('credential_key_must_be_external');
    }
    fs.chmodSync(directory, 0o700);
  }
}
export function writeProtectedJson(file: string, value: unknown) {
  // Seal before touching the previous file: an unavailable keystore cannot
  // destroy the last working configuration or leave a plaintext temporary file.
  const serialized = JSON.stringify(protectConfiguration(value), null, 2) + '\n';
  secureConfigDirectory(path.dirname(file)); assertPrivateConfigFile(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    assertPrivateConfigFile(file); fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function readProtectedJson(file: string): unknown {
  assertPrivateConfigFile(file);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = unprotectConfiguration(stored);
  if (JSON.stringify(protectConfiguration(value)) !== JSON.stringify(stored)) writeProtectedJson(file, value);
  return value;
}
