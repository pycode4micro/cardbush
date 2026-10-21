/** Saved connection IDs are identities; credentials never enter task metadata. */
export interface SshConnection {
  id: string; name: string; host: string; port: number; username: string;
  authentication: 'agent' | 'key' | 'password'; privateKeyPath?: string;
  defaultDirectory: string; fingerprint?: string; hasPassword: boolean; hasPassphrase: boolean;
  status?: 'connected' | 'disconnected';
}
export type SshConnectionInput = Omit<SshConnection, 'id' | 'hasPassword' | 'hasPassphrase' | 'status'> & {
  id?: string; password?: string; passphrase?: string;
};
export interface SshTestResult { ok: boolean; error?: string; fingerprint?: string; needsTrust?: boolean; directory?: string }
export type SshPlatform = 'windows' | 'posix';
export type SshShell = 'cmd' | 'powershell' | 'posix';

/** Windows OpenSSH's SFTP namespace is /C:/..., not a native shell cwd. */
export function windowsSftpPath(value: string): string {
  if (/[\0\r\n]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) throw Error('UNC/device SSH paths are not supported; use an absolute drive path.');
  let path = value.replaceAll('\\', '/');
  if (/^\/[a-z]:$/i.test(path)) path += '/';
  if (/^[a-z]:\//i.test(path)) path = '/' + path;
  const drivePath = /^\/[a-z]:\//i.test(path);
  if ((drivePath ? path.slice(3) : path).includes(':')) {
    throw Error('Use an absolute Windows drive path, for example C:\\Users\\name.');
  }
  return path;
}

export function windowsShellPath(value: string): string {
  const path = windowsSftpPath(value);
  if (!/^\/[a-z]:\//i.test(path)) throw Error('A Windows shell requires a drive directory, for example C:\\Users\\name; the SFTP root / is only for browsing.');
  return path.slice(1).replaceAll('/', '\\');
}

export function sshWorkspace(connectionId: string, path: string): string {
  if (/^[a-z]:[\\/]/i.test(path)) path = windowsSftpPath(path);
  if (!/^[a-z0-9-]+$/.test(connectionId) || !path.startsWith('/') || /[\0\r\n]/.test(path)) throw new Error('Invalid SSH workspace.');
  return `ssh://${connectionId}${path.split('/').map(encodeURIComponent).join('/')}`;
}
export function parseSshWorkspace(value: unknown): { connectionId: string; path: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith('ssh://')) return;
  const match = /^ssh:\/\/([a-z0-9-]+)(\/[^?#]*)?$/.exec(value);
  if (!match) throw new Error('Invalid SSH workspace.');
  const path = decodeURIComponent(match[2] || '/');
  if (/[\0\r\n]/.test(path)) throw new Error('Invalid SSH path.');
  return { connectionId: match[1], path };
}
