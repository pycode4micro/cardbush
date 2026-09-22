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
export function sshWorkspace(connectionId: string, path: string): string {
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
