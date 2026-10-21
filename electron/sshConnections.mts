import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { EventEmitter } from 'node:events';
import { openSshTunnel } from './sshTunnel.mjs';
import { parseSshWorkspace, sshWorkspace, windowsSftpPath, windowsShellPath, type SshPlatform, type SshShell, type SshConnection, type SshConnectionInput, type SshTestResult } from '@cardbush/bush-protocol';
import { posixQuote as quote, remoteShell, remoteProgram, windowsHostProbe, windowsTerminalCommand, windowsTerminalInput, windowsStopCommand } from './sshShell.mjs';
import { workspaceEditRecoveryError } from '@cardbush/bush-runtime/workspace-edit-recovery';
import { createDisplayDiff } from '@cardbush/bush-runtime/workspace-diff';
import { WorkspaceSearchBudget, workspaceSearchArguments, type WorkspaceSearchInput } from '@cardbush/bush-runtime/workspace-search';

type Saved = Omit<SshConnection, 'hasPassword' | 'hasPassphrase' | 'status'> & { password?: string; passphrase?: string };
type Cipher = { encrypt(value: string): string; decrypt(value: string): string };
type Terminal = { id: string; owner: string; connectionId: string; root: string; command: string; cwd: string;
  client: Client; channel: ClientChannel; pid?: number; state: string; exitCode?: number; stdout: string; stderr: string;
  platform: SshPlatform; shell: SshShell; job?: string; ready?: Promise<void>; stop?: Promise<void>;
  truncated: boolean; changed: EventEmitter; startedAt: number; endedAt?: number; lastOutputAt?: number };
type RemoteHost = { platform: SshPlatform; home: string; verifiedShell?: Promise<void> };
const MAX_BYTES = 8 * 1024 * 1024;
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const call = <T,>(operation: (done: (error: Error | null | undefined, value: T) => void) => void) => new Promise<T>((resolve, reject) => operation((error, value) => error ? reject(error) : resolve(value)));
const within = (root: string, path: string, platform: SshPlatform) => {
  if (platform === 'windows') { root = root.toLowerCase(); path = path.toLowerCase(); }
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/');
};

/** Desktop-owned SSH connections. No private key or password is exposed to Runtime or models. */
export class SshConnectionManager {
  #clients = new Map<string, Promise<Client>>();
  #hosts = new WeakMap<Client, Promise<RemoteHost>>();
  #opening = new Map<string, Client>();
  #closing = false;
  #connected = new Set<string>();
  #terminals = new Map<string, Terminal>();
  #runningCommands = new Map<string, string>();
  #searches = new Map<string, Promise<ReturnType<WorkspaceSearchBudget['result']>>>();
  #observed = new Map<string, string>();
  #mutations = new Set<string>();
  #starting = 0;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string, readonly cipher: Cipher) {}
  async #read(): Promise<Saved[]> {
    try { const value = JSON.parse(await readFile(this.file, 'utf8')); if (!Array.isArray(value)) throw Error('Invalid SSH configuration'); return value; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async list(): Promise<SshConnection[]> {
    return (await this.#read()).map(({ password, passphrase, ...item }) => ({ ...item, hasPassword: Boolean(password), hasPassphrase: Boolean(passphrase), status: this.#connected.has(item.id) ? 'connected' : 'disconnected' }));
  }
  async #commit(items: Saved[]) {
    await mkdir(dirname(this.file), { recursive: true }); const temporary = this.file + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(items, null, 2), { mode: 0o600 }); await rename(temporary, this.file);
  }
  #serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.#queue.then(operation); this.#queue = next.catch(() => {}); return next; }
  save(input: SshConnectionInput): Promise<SshConnection[]> {
    return this.#serial(async () => {
      const items = await this.#read(), old = items.find(item => item.id === input.id);
      if (input.id && !old) throw Error('SSH connection no longer exists.');
      if (!input.name?.trim() || !/^[a-zA-Z0-9.:_-]+$/.test(input.host) || !/^[^\s\0\r\n]+$/.test(input.username) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !['agent','key','password'].includes(input.authentication)) throw Error('请填写有效的名称、主机、端口和用户。');
      if (old && (old.host !== input.host || old.port !== input.port || old.username !== input.username)) throw Error('主机、端口或用户变化时请新增连接，避免已有项目指向另一台主机。');
      if (old && this.#busy(old.id)) throw Error('请先停止此 SSH 连接中的运行任务，再修改连接。');
      const supplied = input.defaultDirectory?.trim() || '/';
      const directory = /^[a-z]:[\\/]|^\/[a-z]:/i.test(supplied) ? windowsSftpPath(supplied) : supplied;
      if (!directory.startsWith('/') || /[\0\r\n]/.test(directory)) throw Error('远程目录必须是绝对路径，例如 /home/user 或 C:\\Users\\user。');
      if (input.fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.fingerprint)) throw Error('Invalid SSH host fingerprint.');
      if (input.authentication === 'key' && !input.privateKeyPath?.trim()) throw Error('请选择私钥文件。');
      const item: Saved = { id: old?.id ?? randomUUID(), name: input.name.trim(), host: input.host, port: input.port, username: input.username,
        authentication: input.authentication, privateKeyPath: input.privateKeyPath, defaultDirectory: posix.normalize(directory), fingerprint: input.fingerprint || old?.fingerprint,
        password: input.password === undefined ? old?.password : input.password ? this.cipher.encrypt(input.password) : undefined,
        passphrase: input.passphrase === undefined ? old?.passphrase : input.passphrase ? this.cipher.encrypt(input.passphrase) : undefined };
      if (item.authentication === 'password' && !item.password) throw Error('请输入 SSH 密码。');
      if (old) await this.disconnect(old.id);
      await this.#commit([...items.filter(value => value.id !== item.id), item]); return this.list();
    });
  }
  remove(id: string) { return this.#serial(async () => { if (this.#busy(id)) throw Error('连接中还有运行任务，请先停止。'); await this.disconnect(id); await this.#commit((await this.#read()).filter(item => item.id !== id)); return this.list(); }); }
  #busy(id: string) { return [...this.#terminals.values()].some(item => item.connectionId === id && item.state === 'running'); }
  async disconnect(id: string) { if (this.#busy(id)) throw Error('连接中还有运行任务，请先停止。'); const pending = this.#clients.get(id); this.#clients.delete(id); this.#connected.delete(id); this.#opening.get(id)?.destroy(); (await pending?.catch(() => undefined))?.end(); }
  async #connection(id: string): Promise<Client> {
    if (this.#closing) throw Error('SSH connections are closing.');
    const cached = this.#clients.get(id); if (cached) return cached;
    let pending!: Promise<Client>;
    pending = (async () => {
      const item = (await this.#read()).find(value => value.id === id); if (!item) throw Error('SSH 连接已删除，请在设置中重新选择连接。');
      const key = item.authentication === 'key' ? await readFile(item.privateKeyPath!) : undefined;
      if (key && key.length > 1024 * 1024) throw Error('SSH 私钥文件过大，请确认选择了正确的密钥文件。');
      if (item.authentication === 'agent' && process.platform !== 'win32' && !process.env.SSH_AUTH_SOCK) throw Error('SSH Agent 不可用，请启动 ssh-agent 或选择私钥文件。');
      if (this.#closing || this.#clients.get(id) !== pending) throw Error('SSH 连接已关闭。');
      return new Promise<Client>((resolve, reject) => {
        const client = new Client(); this.#opening.set(id, client); let verifiedKey: string | undefined;
        const failure = (error: Error) => { reject(verifiedKey && verifiedKey !== item.fingerprint ? Object.assign(new Error(item.fingerprint ? 'SSH 主机指纹已变化，请核对服务器身份。' : '首次连接，请确认 SSH 主机指纹。'), { fingerprint: verifiedKey, needsTrust: !item.fingerprint }) : error); };
        client.on('error', failure).once('ready', () => {
          if (this.#opening.get(id) === client) this.#opening.delete(id);
          if (this.#closing || this.#clients.get(id) !== pending) { client.end(); reject(Error('SSH 连接已关闭。')); return; }
          this.#connected.add(id); resolve(client);
        });
        client.once('close', () => {
          if (this.#opening.get(id) === client) this.#opening.delete(id);
          if (this.#clients.get(id) === pending) { this.#clients.delete(id); this.#connected.delete(id); }
          for (const terminal of this.#terminals.values()) if (terminal.client === client && terminal.state === 'running') { terminal.state = 'disconnected'; terminal.changed.emit('data'); }
          reject(Error('SSH 连接已关闭。任务不会自动重放。'));
        });
        client.connect({ host: item.host, port: item.port, username: item.username, privateKey: key,
          password: item.authentication === 'password' && item.password ? this.cipher.decrypt(item.password) : undefined,
          passphrase: item.passphrase ? this.cipher.decrypt(item.passphrase) : undefined,
          agent: item.authentication === 'agent' ? process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined) : undefined,
          hostVerifier: (bytes: Buffer) => { verifiedKey = 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, ''); return verifiedKey === item.fingerprint; },
          readyTimeout: 15_000, keepaliveInterval: 10_000, keepaliveCountMax: 3 });
      });
    })();
    this.#clients.set(id, pending); try { return await pending; } catch (error) { if (this.#clients.get(id) === pending) this.#clients.delete(id); throw error; }
  }
  async test(id: string): Promise<SshTestResult> {
    try { const item = (await this.#read()).find(value => value.id === id); if (!item) throw Error('SSH connection not found'); const directory = await this.directory(sshWorkspace(id, item.defaultDirectory)); return { ok: true, directory: directory.path }; }
    catch (error) { const detail = error as Error & { fingerprint?: string; needsTrust?: boolean }; return { ok: false, error: detail.message, fingerprint: detail.fingerprint, needsTrust: detail.needsTrust }; }
  }
  async tunnel(id: string, remoteHost: string, remotePort: number, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
    const client = await Promise.race([this.#connection(id), cancelled]).finally(() => signal.removeEventListener('abort', abort));
    signal.throwIfAborted();
    return openSshTunnel(client, remoteHost, remotePort, signal);
  }
  async #sftp<T>(id: string, action: (sftp: SFTPWrapper) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); const client = await this.#connection(id); signal?.throwIfAborted();
    const sftp = await call<SFTPWrapper>(done => client.sftp(done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => sftp.end(); signal?.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([action(sftp), new Promise<never>((_, reject) => { timer = setTimeout(() => { sftp.end(); reject(Error('SSH 文件操作超时。')); }, 30_000); sftp.once('close', () => reject(signal?.reason ?? Error('SSH 文件通道已关闭。'))); })]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); sftp.end(); }
  }
  async #host(id: string, verifyShell = true): Promise<RemoteHost> {
    const client = await this.#connection(id);
    let pending = this.#hosts.get(client);
    if (!pending) {
      pending = this.#sftp(id, async sftp => {
        const home = await this.#canonical(sftp, '.');
        return { platform: /^\/[a-z]:\//i.test(home) ? 'windows' as const : 'posix' as const, home };
      });
      this.#hosts.set(client, pending);
    }
    let host: RemoteHost;
    try { host = await pending; } catch (error) { this.#hosts.delete(client); throw error; }
    // SFTP-only accounts retain file access without requiring an exec channel.
    // A filesystem namespace is only a hint; commands need an actual OS probe.
    if (!verifyShell) return host;
    host.verifiedShell ??= (async () => {
      if (host.platform === 'windows') {
        const probe = await this.#captureChannel(client, windowsHostProbe, 10_000);
        if (probe.exitCode === 0 && probe.stdout.trim() === 'CARDBUSH_HOST_WINDOWS_V1') return;
      } else {
        const probe = await this.#captureChannel(client, 'uname -s', 10_000);
        if (probe.exitCode === 0 && /^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS)\s*$/.test(probe.stdout)) return;
      }
      throw Object.assign(Error('Cannot verify the SSH operating system and shell. No user command was sent.'), { code: 'ssh_platform_unavailable' });
    })();
    try { await host.verifiedShell; } catch (error) { host.verifiedShell = undefined; throw error; }
    return host;
  }
  async #canonical(sftp: SFTPWrapper, path: string, missing = false): Promise<string> {
    try { const value = await call<string>(done => sftp.realpath(path, done)); return /^[a-z]:[\\/]|^\/[a-z]:/i.test(value) ? windowsSftpPath(value) : value; }
    catch (error) { if (!missing || (error as { code?: number }).code !== 2 || path === '/') throw error; return posix.join(await this.#canonical(sftp, posix.dirname(path), true), posix.basename(path)); }
  }
  async directory(uri: string) {
    const target = parseSshWorkspace(uri); if (!target) throw Error('Expected SSH workspace');
    return this.#sftp(target.connectionId, async sftp => {
      const path = await this.#canonical(sftp, target.path); const stats = await call<import('ssh2').Stats>(done => sftp.stat(path, done));
      if (!stats.isDirectory()) throw Error('远程路径不是目录。');
      const entries = await call<import('ssh2').FileEntry[]>(done => sftp.readdir(path, done));
      return { path, uri: sshWorkspace(target.connectionId, path), entries: entries.filter(item => item.filename !== '.' && item.filename !== '..' && item.filename !== '.git').map(item => ({ name: item.filename, path: sshWorkspace(target.connectionId, posix.join(path, item.filename)), kind: (item.attrs.mode & 0o170000) === 0o040000 ? 'folder' as const : 'file' as const })).sort((a,b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name)) };
    });
  }
  async authorize(uri: string, path: string, write = false, terminal?: { shell?: string }, signal?: AbortSignal) {
    const target = parseSshWorkspace(uri)!;
    const host = await this.#host(target.connectionId, Boolean(terminal)); signal?.throwIfAborted();
    const shell = terminal ? remoteShell(host.platform, terminal.shell) : undefined;
    return this.#sftp(target.connectionId, async sftp => {
      const root = await this.#canonical(sftp, target.path);
      const resolved = await this.#canonical(sftp, this.#path(target.connectionId, root, path, host.platform), write);
      return { path: sshWorkspace(target.connectionId, resolved), root: sshWorkspace(target.connectionId, root),
        home: host.home, inside: within(root, resolved, host.platform), platform: host.platform,
        ...(shell ? { shell, nativeCwd: host.platform === 'windows' ? windowsShellPath(resolved) : resolved } : {}) };
    }, signal);
  }
  #path(id: string, root: string, value = '.', platform: SshPlatform = 'posix') {
    const reference = parseSshWorkspace(value);
    if (value.startsWith('ssh:') && !reference) throw Error('Invalid SSH workspace path.');
    if (reference && reference.connectionId !== id) throw Error('文件属于另一条 SSH 连接，请先切换远程项目。');
    let path = reference?.path ?? value;
    if (/[\0\r\n]/.test(path)) throw Error('Invalid remote path.');
    if (platform === 'windows') return windowsSftpPath(posix.resolve(root, windowsSftpPath(path || '.')));
    if (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)) throw Error('This SSH host uses POSIX paths. For local files use environment="local".');
    return posix.resolve(root, path || '.');
  }
  async #readBytes(sftp: SFTPWrapper, path: string, limit = MAX_BYTES, prefix = false): Promise<Buffer> {
    return new Promise((resolve, reject) => { const stream = sftp.createReadStream(path, prefix ? { start: 0, end: limit - 1 } : {}); const chunks: Buffer[] = []; let size = 0;
      stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) stream.destroy(Error('远程文件超过读取上限，请使用终端分段读取。')); else chunks.push(chunk); });
      stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(chunks))); });
  }
  async snapshot(uri: string, maxBytes = 0, signal?: AbortSignal, prefix = false) {
    const target = parseSshWorkspace(uri);
    if (!target || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES) throw Error('Invalid SSH file snapshot request.');
    return this.#sftp(target.connectionId, async sftp => {
      const path = await this.#canonical(sftp, target.path);
      const before = await call<import('ssh2').Stats>(done => sftp.stat(path, done));
      if (!before.isFile() && !before.isDirectory()) throw Error('Unsupported remote file type.');
      const bytes = before.isFile() && maxBytes > 0 && (prefix || before.size <= maxBytes)
        ? await this.#readBytes(sftp, path, maxBytes, prefix) : undefined;
      const after = await call<import('ssh2').Stats>(done => sftp.stat(path, done));
      if (before.size !== after.size || before.mtime !== after.mtime || (bytes && bytes.length !== Math.min(before.size, maxBytes))) throw Error('远程文件在读取时发生变化，请重试。');
      return { path: sshWorkspace(target.connectionId, path), name: posix.basename(path), kind: before.isFile() ? 'file' as const : 'folder' as const,
        size: after.size, mtimeMs: after.mtime * 1000, truncated: Boolean(bytes && before.size > bytes.length),
        ...(bytes ? { contentBase64: bytes.toString('base64') } : {}) };
    }, signal);
  }
  async #ensureDirectory(sftp: SFTPWrapper, path: string): Promise<void> {
    try { const stats = await call<import('ssh2').Stats>(done => sftp.stat(path, done)); if (!stats.isDirectory()) throw Error('远程父路径不是目录。'); }
    catch (error) { if ((error as { code?: number }).code !== 2 || path === '/') throw error; await this.#ensureDirectory(sftp, posix.dirname(path)); await call<void>(done => sftp.mkdir(path, done)); }
    if (await this.#canonical(sftp, path) !== path) throw Error('远程父目录链接发生变化，请重新确认路径。');
  }
  listTerminals(owner: string) {
    return { sessions: [...this.#terminals.values()].filter(item => item.owner === owner).map(item => ({
      terminalSessionId: item.id, uri: item.root, state: item.state, command: item.command, cwd: item.cwd, platform: item.platform, shell: item.shell, exitCode: item.exitCode ?? null, ...terminalTiming(item),
    })) };
  }

  async execute(uri: string, owner: string, name: string, input: Record<string, any>, signal?: AbortSignal): Promise<unknown> {
    const target = parseSshWorkspace(uri); if (!target) throw Error('Expected SSH workspace');
    signal?.throwIfAborted();
    if (name === 'file_snapshot') return this.snapshot(sshWorkspace(target.connectionId, this.#path(target.connectionId, target.path, input.path, (await this.#host(target.connectionId, false)).platform)), input.maxBytes ?? 0, signal);
    if (name === 'workspace_busy') return { running: [...this.#terminals.values()].some(item => item.root === uri && item.state === 'running') };
    if (name === 'workspace_stop') { await Promise.all([...this.#terminals.values()].filter(item => item.root === uri).map(item => this.#stop(item))); return { stopped:true }; }
    if (name === 'terminal_list') return { sessions: [...this.#terminals.values()].filter(item => item.owner === owner && item.connectionId === target.connectionId).map(item => ({ terminalSessionId: item.id, state: item.state, command: item.command, cwd: item.cwd })) };
    if (['terminal_poll','terminal_write','terminal_stop','terminal_observe'].includes(name)) {
      const terminal = this.#terminals.get(input.sessionId);
      if (!terminal || terminal.owner !== owner || terminal.connectionId !== target.connectionId) throw Error('远程终端不属于当前会话。');
      if (name === 'terminal_write') { if (terminal.state !== 'running') throw Error('远程终端已停止。'); terminal.channel.write(input.chars); }
      if (name === 'terminal_stop') await this.#stop(terminal);
      return this.#poll(terminal, name === 'terminal_stop' ? 1 : input.yieldTimeMs, signal, name === 'terminal_observe');
    }
    const host = await this.#host(target.connectionId, name === 'terminal_exec' || name === 'search_file_content'); signal?.throwIfAborted();
    if (name === 'terminal_exec' || name === 'search_file_content') {
      const path = this.#path(target.connectionId, target.path, input.cwd ?? input.path, host.platform);
      const shell = remoteShell(host.platform, name === 'terminal_exec' ? input.shell : undefined);
      if (name === 'search_file_content') return this.#searchFileContent(uri, owner, path, input, signal);
      const command = input.command;
      const terminal = await this.#start(target.connectionId, uri, owner, command, path, signal, undefined, shell);
      try { return await this.#poll(terminal, input.yieldTimeMs ?? 1000, signal); }
      catch (error) { await this.#stop(terminal).catch(() => {}); throw error; }
    }
    return this.#sftp(target.connectionId, async sftp => {
      const path = await this.#canonical(sftp, this.#path(target.connectionId, target.path, input.path, host.platform), name === 'write_file');
      const identity = sshWorkspace(target.connectionId, path), mutation = host.platform === 'windows' ? identity.toLowerCase() : identity, observation = owner + ':' + mutation;
      if (name === 'read_file') {
        const bytes = await this.#readBytes(sftp, path), hash = sha(bytes); this.#observed.set(observation, hash);
        const text = bytes.toString(input.encoding ?? 'utf8');
        if (!input.range) return { path: identity, sha256: hash, content: text };
        const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [], start = input.range.startLine - 1, end = Math.min(lines.length, start + input.range.lineCount);
        return { path: identity, sha256: hash, content: lines.slice(start,end).join(''), start_line: input.range.startLine, end_line: start < lines.length ? end : null, total_lines: lines.length, next_start_line: end < lines.length ? end + 1 : null };
      }
      if (name !== 'write_file' && name !== 'edit_file') throw Error('Unsupported remote workspace tool: ' + name);
      if (this.#mutations.has(mutation)) throw Error('此远程文件正在被另一个操作修改。'); this.#mutations.add(mutation);
      try {
        let before: Buffer | undefined;
        try { before = await this.#readBytes(sftp, path); } catch (error) { if ((error as { code?: number }).code !== 2 || name === 'edit_file') throw error; }
        if (before && this.#observed.get(observation) !== sha(before)) {
          if (name === 'edit_file') throw workspaceEditRecoveryError('workspace_revision_not_observed', '远程文件尚未读取或版本已变化。');
          throw Error('远程文件尚未读取或已变化，请先重新 read_file。');
        }
        let content = input.content;
        if (name === 'edit_file') {
          const original = before!.toString(input.encoding);
          if (input.range) {
            if (sha(before!) !== input.range.sha256) throw workspaceEditRecoveryError('workspace_revision_mismatch', '远程文件版本与 expected_sha256 不一致。');
            const lines = original.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
            if (input.range.end > lines.length) throw workspaceEditRecoveryError('edit_line_range_invalid', `编辑行范围超出文件（共 ${lines.length} 行）。`);
            content = lines.slice(0, input.range.start - 1).join('') + input.newText + lines.slice(input.range.end).join('');
          } else {
            const count = original.split(input.oldText).length - 1;
            if (!count) throw workspaceEditRecoveryError('edit_old_text_not_found', 'old_text 未匹配当前远程文件。');
            if (!input.replaceAll && count !== 1) throw workspaceEditRecoveryError('edit_old_text_ambiguous', `old_text 匹配 ${count} 处，目标不唯一。`);
            content = input.replaceAll ? original.replaceAll(input.oldText, () => input.newText) : original.replace(input.oldText, () => input.newText);
          }
        }
        const next = Buffer.from(content, input.encoding ?? 'utf8'); if (next.length > MAX_BYTES) throw Error('远程写入超过 8 MiB。');
        const temporary = path + '.cardbush-' + randomUUID();
        try {
          await this.#ensureDirectory(sftp, posix.dirname(path));
          const stats = before ? await call<import('ssh2').Stats>(done => sftp.stat(path, done)) : undefined;
          await call<void>(done => sftp.writeFile(temporary, next, { flag: 'wx', mode: stats ? stats.mode & 0o777 : 0o644 }, done));
          if (before && sha(await this.#readBytes(sftp,path)) !== sha(before)) {
            if (name === 'edit_file') throw workspaceEditRecoveryError('workspace_revision_mismatch', '远程文件在写入前版本发生变化。');
            throw Error('远程文件在写入前发生变化，请重新读取。');
          }
          // The ordinary SFTP rename refuses to overwrite a concurrently created file.
          await call<void>(done => before ? sftp.ext_openssh_rename(temporary,path,done) : sftp.rename(temporary,path,done));
        } catch (error) { await call<void>(done => sftp.unlink(temporary,done)).catch(() => {}); throw error; }
        const diff = createDisplayDiff(before?.toString(input.encoding ?? 'utf8') ?? '', next.toString(input.encoding ?? 'utf8'));
        const changeId = 'ssh-change-' + randomUUID();
        this.#observed.set(observation, sha(next));
        return { path: identity, sha256: sha(next), bytes: next.length, status: before ? 'modified' : 'created',
          change_id: changeId, additions: diff.additions, deletions: diff.deletions,
          workspaceChange: { change_id: changeId, path: identity, status: before ? 'modified' : 'added', additions: diff.additions, deletions: diff.deletions,
            ...(before ? { before_hash: sha(before) } : {}), after_hash: sha(next),
            metadata: { diff: diff.text, workspaceVersioned: false, revertSupported: false } } };
      } finally { this.#mutations.delete(mutation); }
    }, signal);
  }
  async #start(id: string, root: string, owner: string, command: string, cwd: string, signal?: AbortSignal, onOutput?: (key: 'stdout' | 'stderr', chunk: string) => void, requestedShell?: SshShell) {
    const host = await this.#host(id), shell = remoteShell(host.platform, requestedShell);
    signal?.throwIfAborted();
    if (host.platform === 'windows' && Buffer.byteLength(command, 'utf8') > MAX_BYTES) throw Error('Windows SSH command exceeds 8 MiB.');
    for (const [key, terminal] of this.#terminals) if (this.#terminals.size > 200 && terminal.state !== 'running' && Date.now() - terminal.startedAt > 3_600_000) this.#terminals.delete(key);
    if (this.#starting + [...this.#terminals.values()].filter(item => item.state === 'running').length >= 16) throw Error('远程终端并发已达上限。');
    const commandKey = JSON.stringify([id, owner, host.platform === 'windows' ? cwd.toLowerCase() : cwd, shell, command]);
    const existing = this.#runningCommands.get(commandKey);
    if (existing) throw Object.assign(Error('相同命令仍在运行，请先处理其他独立工作，需要结果时使用现有终端，不要重复启动。'), {
      code: 'terminal_command_already_running', details: { terminalSessionId: existing, state: this.#terminals.get(existing)?.state ?? 'starting' },
    });
    const terminalId = 'ssh-terminal-' + randomUUID();
    this.#runningCommands.set(commandKey, terminalId);
    this.#starting++;
    try {
    const client = await this.#connection(id); signal?.throwIfAborted();
    const marker = 'CARDBUSH_PID_' + randomUUID().replaceAll('-','') + ':';
    const job = host.platform === 'windows' ? 'Global\\CardBushSsh_' + randomUUID().replaceAll('-', '') : undefined;
    const startToken = randomUUID();
    const script = `printf ${quote(marker + '%s\n')} "$$" >&2; exec /bin/sh -c ${quote(command)}`;
    // sshd may already make its child a session leader. --wait preserves the
    // command's exit status when setsid must fork (setsid(1), util-linux).
    const launch = job ? windowsTerminalCommand({ cwd, shell, job, marker, startToken })
      : { command: `cd ${quote(cwd)} && exec setsid --wait /bin/sh -c ${quote(script)}`, prelude: '' };
    const channel = await this.#execChannel(client, launch.command, signal);
    const terminal: Terminal = { id: terminalId, connectionId: id, root, owner, command, cwd: host.platform === 'windows' ? windowsShellPath(cwd) : cwd,
      platform: host.platform, shell, ...(job ? { job } : {}), client, channel, state: 'running', stdout: '', stderr: '', truncated: false, changed: new EventEmitter(), startedAt: Date.now() };
    this.#terminals.set(terminal.id, terminal); let pendingError = '';
    const append = (key: 'stdout' | 'stderr', chunk: string) => { if (chunk) terminal.lastOutputAt = Date.now(); if (onOutput) onOutput(key, chunk); else { terminal[key] += chunk; if (Buffer.byteLength(terminal[key]) > 512 * 1024) { terminal[key] = terminal[key].slice(-128 * 1024); terminal.truncated = true; } } terminal.changed.emit('data'); };
    channel.setEncoding('utf8'); channel.stderr.setEncoding('utf8');
    channel.on('data',(chunk: string) => append('stdout',chunk));
    channel.stderr.on('data',(chunk: string) => { if (terminal.pid) return append('stderr',chunk); pendingError += chunk; const match = new RegExp(marker + '(\\d+)\\r?\\n').exec(pendingError); if (match) { terminal.pid = Number(match[1]); append('stderr',pendingError.replace(match[0],'')); pendingError = ''; terminal.changed.emit('data'); } else if (pendingError.length > 4096) { append('stderr',pendingError); pendingError=''; } });
    channel.on('error',(error: Error) => { append('stderr',error.message); terminal.state='failed'; terminal.endedAt=Date.now(); terminal.changed.emit('data'); });
    channel.on('close',(code: number, signal?: string) => { this.#runningCommands.delete(commandKey); if (pendingError) append('stderr',pendingError); if (terminal.state === 'running') terminal.state=typeof code === 'number' || signal ? 'completed' : 'disconnected'; terminal.exitCode=code; terminal.endedAt=Date.now(); terminal.changed.emit('data'); });
    if (job) {
      channel.write(launch.prelude);
      // No user code runs until ownership is established and this request is
      // still live. This also makes late channel delivery after cancellation safe.
      terminal.ready = (async () => {
        const deadline = Date.now() + 15_000;
        while (!terminal.pid && terminal.state === 'running') {
          if (Date.now() > deadline) throw Error('Windows SSH process ownership handshake timed out. No user command was released.');
          await this.#poll(terminal, 100, signal, true);
        }
        signal?.throwIfAborted();
        if (terminal.pid && terminal.state === 'running') channel.write(windowsTerminalInput(command, shell, startToken));
      })();
      try { await terminal.ready; }
      catch (error) {
        // EOF releases a wrapper waiting for the start token without running the command.
        channel.end();
        await this.#stop(terminal).catch(() => {});
        throw error;
      }
    }
    return terminal;
    } catch (error) { this.#runningCommands.delete(commandKey); throw error; }
    finally { this.#starting--; }
  }
  #execChannel(client: Client, command: string, signal?: AbortSignal): Promise<ClientChannel> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, channel?: ClientChannel) => {
        if (settled) { if (channel) { channel.on('error', () => {}); channel.signal('TERM'); channel.close(); } return; }
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(channel!);
      };
      const abort = () => finish(Error('SSH 等待已取消，远程命令可能已启动，请核对进程。'));
      const timer = setTimeout(() => finish(Error('SSH 命令通道响应超时，远程执行结果未知，请核对进程。')), 15_000);
      signal?.addEventListener('abort', abort, { once:true });
      try { client.exec(command, (error, channel) => finish(error, channel)); } catch(error) { finish(error as Error); }
    });
  }
  async #captureChannel(client: Client, command: string, timeout: number, signal?: AbortSignal) {
    const budget = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    const channel = await this.#execChannel(client, command, budget);
    return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      let stdout = '', stderr = '', settled = false;
      const finish = (error?: unknown, code?: number) => {
        if (settled) return; settled = true; budget.removeEventListener('abort', abort);
        if (error) { channel.close(); reject(error); }
        else resolve({ stdout, stderr, exitCode: code ?? null });
      };
      const abort = () => finish(budget.reason);
      channel.setEncoding('utf8'); channel.stderr.setEncoding('utf8');
      const append = (kind: 'stdout'|'stderr', value: string) => {
        if (kind === 'stdout') stdout += value; else stderr += value;
        if (Buffer.byteLength(stdout + stderr) > 16_384) finish(Error('SSH control response exceeds its limit.'));
      };
      channel.on('data', (value: string) => append('stdout', value));
      channel.stderr.on('data', (value: string) => append('stderr', value));
      channel.on('error', finish); channel.once('close', (code: number) => finish(undefined, code));
      budget.addEventListener('abort', abort, { once: true }); if (budget.aborted) abort();
    });
  }
  async #stop(terminal: Terminal) {
    if (terminal.stop) return terminal.stop;
    const pending = this.#stopOwned(terminal); terminal.stop = pending;
    try { await pending; } finally { terminal.stop = undefined; }
  }
  async #stopOwned(terminal: Terminal) {
    if (terminal.state === 'disconnected' || terminal.state === 'failed') throw Error('无法确认远程进程已停止，请重连后检查进程。');
    if (terminal.state !== 'running') return;
    const waitForExit = async () => { const deadline = Date.now() + 1500; while (terminal.state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25)); };
    if (terminal.job) {
      // Close the startup gate as well as terminating a named, owned job. Never
      // kill an arbitrary PID, and never turn a transport failure into "stopped".
      if (!terminal.pid) terminal.channel.end();
      const result = await this.#captureChannel(terminal.client, windowsStopCommand(terminal.job), 15_000);
      if (result.exitCode !== 0 || result.stdout.trim() !== 'CARDBUSH_STOPPED_V1') throw Error('无法确认 Windows SSH 进程树已停止。' + result.stderr);
      await waitForExit();
      if (terminal.state === 'running' || terminal.state === 'disconnected' || terminal.state === 'failed') throw Error('无法确认 Windows SSH 进程通道已结束。');
      terminal.state = 'stopped'; terminal.changed.emit('data'); return;
    }
    // Wait briefly for the process group marker before trying to kill the group.
    const deadline = Date.now() + 1000;
    while (!terminal.pid && terminal.state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    for (const signal of ['TERM','KILL']) {
      if (terminal.state !== 'running') break;
      if (terminal.pid) {
        const channel = await this.#execChannel(terminal.client, `kill -${signal} -${terminal.pid}`, AbortSignal.timeout(2000));
        channel.on('error', () => {}); channel.resume(); channel.stderr.resume();
        const timer = setTimeout(() => channel.close(), 1500); channel.once('close', () => clearTimeout(timer));
      } else terminal.channel.signal(signal);
      await waitForExit();
    }
    if (terminal.state === 'running' || terminal.state === 'disconnected') throw Error('无法确认远程进程已停止，请重连后检查进程。');
    terminal.state='stopped'; terminal.changed.emit('data');
  }
  async #searchFileContent(uri: string, owner: string, path: string, input: Record<string, any>, signal?: AbortSignal) {
    const key = JSON.stringify([uri, owner, path, input]);
    const running = this.#searches.get(key);
    if (running) return { ...await running, reused: true };
    const pending = this.#runFileSearch(uri, owner, path, input, signal);
    this.#searches.set(key, pending);
    try { return await pending; } finally { this.#searches.delete(key); }
  }
  async #runFileSearch(uri: string, owner: string, path: string, input: Record<string, any>, signal?: AbortSignal) {
    const target = parseSshWorkspace(uri)!;
    const search: WorkspaceSearchInput = { path, query: input.query, regex: input.regex ?? false, globs: input.globs ?? [],
      contextBefore: input.contextBefore ?? 0, contextAfter: input.contextAfter ?? 0, outputMode: input.outputMode ?? 'lines',
      maxResults: input.maxResults ?? 100, maxOutputBytes: input.maxOutputBytes ?? 65536, timeoutMs: input.timeoutMs ?? 10000,
      includeDependencies: input.includeDependencies ?? false };
    const budget = new WorkspaceSearchBudget(search, signal);
    const timer = setTimeout(() => budget.stop('timeout'), search.timeoutMs);
    let terminal: Terminal | undefined;
    try {
      const host = await this.#host(target.connectionId);
      const nativePath = host.platform === 'windows' ? windowsShellPath(path) : path;
      terminal = await this.#start(target.connectionId, uri, owner, remoteProgram(host.platform, 'rg', workspaceSearchArguments(nativePath, search)), target.path, budget.signal,
        (key, chunk) => { if (key === 'stdout') budget.append(Buffer.from(chunk)); else if (chunk && !budget.limit) budget.warn(chunk); });
      while (terminal.state === 'running' && budget.check()) await this.#poll(terminal, 1000, budget.signal, true);
      return budget.result(terminal.exitCode ?? 2);
    } catch (error) {
      signal?.throwIfAborted();
      if (!budget.limit) throw error;
      return budget.result(2);
    } finally {
      clearTimeout(timer);
      if (terminal) {
        try { if (terminal.state === 'running') await this.#stop(terminal); }
        finally { if (terminal.state !== 'running') this.#terminals.delete(terminal.id); }
      }
    }
  }
  async #capture(uri: string, command: string | ((platform: SshPlatform) => string), accepted = [0], signal?: AbortSignal) {
    const target = parseSshWorkspace(uri)!;
    const host = await this.#host(target.connectionId);
    const terminal = await this.#start(target.connectionId, uri, '__desktop__', typeof command === 'function' ? command(host.platform) : command, target.path, signal);
    let stdout = '', stderr = ''; const deadline = Date.now() + 30_000;
    try {
      do {
        const result = await this.#poll(terminal, 1000, signal); stdout += result.stdout; stderr += result.stderr;
        if (terminal.truncated || Buffer.byteLength(stdout + stderr) > MAX_BYTES) throw Error('远程输出过大，请缩小查询范围。');
        if (Date.now() > deadline && terminal.state === 'running') throw Error('SSH 命令超时。');
      } while (terminal.state === 'running');
      if (!accepted.includes(terminal.exitCode!)) throw Error(stderr.trim() || `SSH 命令未成功完成（${terminal.state}）。`);
      return { stdout, stderr, exitCode: terminal.exitCode };
    } catch (error) { await this.#stop(terminal).catch(() => {}); throw error; }
    finally { if (terminal.state !== 'running') this.#terminals.delete(terminal.id); }
  }
  async searchFiles(uri: string, query: string) {
    const target = parseSshWorkspace(uri)!;
    const { stdout } = await this.#capture(uri, platform => remoteProgram(platform, 'rg', ['--files', '--hidden', '-g', '!.git', '--null']), [0,1]);
    const host = await this.#host(target.connectionId);
    return stdout.split('\0').filter(path => path && path.toLowerCase().includes(query.toLowerCase())).slice(0,100).map(path => {
      const resolved = this.#path(target.connectionId, target.path, path, host.platform);
      return { name: posix.basename(resolved), path: sshWorkspace(target.connectionId, resolved), relativePath: path, kind: 'file' as const };
    });
  }
  async git(uri: string, action: 'info'|'branches'|'checkout'|'create-branch'|'commit'|'push', value = ''): Promise<any> {
    const git = async (...args: string[]) => (await this.#capture(uri, platform => remoteProgram(platform, 'git', args, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }))).stdout;
    if (action === 'info') {
      try { const branch = (await git('branch','--show-current')).trim(), fields = (await git('status','--porcelain=v1','-z')).split('\0'), changedFiles = [];
        for (let index = 0; index < fields.length; index++) { const entry=fields[index]; if (!entry) continue; changedFiles.push({ status:entry.slice(0,2).trim(),path:entry.slice(3) }); if (/[RC]/.test(entry.slice(0,2))) index++; }
        return { branch, root:uri, changedFiles };
      } catch(error) { const message = (error as Error).message; return { branch:'', root:uri, changedFiles:[],
        ...(/not a git repository/i.test(message) ? { missing: true } : { error: message }) }; }
    }
    if (action === 'branches') return (await git('branch','-a','--format=%(refname:short)')).split('\n').map(value=>value.trim()).filter(value=>value&&!value.endsWith('/HEAD'));
    if (this.#busy(parseSshWorkspace(uri)!.connectionId)) throw Error('请先结束远程运行任务，再操作 Git。');
    let output: string;
    if (action === 'checkout' || action === 'create-branch') {
      const branch=value.trim(); if (!branch || branch.startsWith('-') || /[\0\r\n]/.test(branch)) throw Error('Invalid branch name');
      await git('check-ref-format','--branch',branch);
      const local=(await git('branch','--format=%(refname:short)')).trim().split('\n');
      output=await git('switch',...(action==='create-branch'?['-c']:local.includes(branch)?[]:branch.includes('/')?['--track']:[]),branch);
      return { branch:(await git('branch','--show-current')).trim(),output:output.trim()||branch };
    }
    if (action === 'commit') { if(!value.trim())throw Error('Commit message is empty'); await git('add','-A'); output=await git('commit','-m',value); }
    else { const branch=(await git('branch','--show-current')).trim(); if(!branch)throw Error('Cannot push detached HEAD'); let upstream='';try{upstream=await git('rev-parse','--abbrev-ref','--symbolic-full-name','@{u}');}catch{} output=upstream.trim()?await git('push'):await git('push','-u','origin',branch); }
    return { output: output.trim() };
  }
  async #poll(terminal: Terminal, milliseconds: number, signal?: AbortSignal, observe = false): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (terminal.state === 'running' && (observe || (!terminal.stdout && !terminal.stderr))) await new Promise<void>((resolve,reject) => {
      const changed = () => { if (!observe || terminal.state !== 'running') done(); };
      const done = () => { clearTimeout(timer); terminal.changed.off('data',changed); signal?.removeEventListener('abort',abort); resolve(); };
      const abort = () => { done(); reject(signal?.reason); };
      const timer=setTimeout(done,Math.min(30_000,Math.max(1,milliseconds))); terminal.changed.on('data',changed); signal?.addEventListener('abort',abort,{once:true});
    });
    signal?.throwIfAborted();
    // SSH can yield before the PID arrives or without an exit status after a
    // disconnect. Unknown values must remain JSON-native at the runtime boundary.
    const result = {
      terminalSessionId: terminal.id,
      pid: terminal.pid ?? null,
      state: terminal.state,
      command: terminal.command,
      cwd: terminal.cwd,
      platform: terminal.platform,
      shell: terminal.shell,
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      exitCode: terminal.exitCode ?? null,
      outputTruncated: terminal.truncated,
      ...terminalTiming(terminal),
    };
    if (!observe) { terminal.stdout='';terminal.stderr=''; } return result;
  }
  async close() { this.#closing = true; for (const client of this.#opening.values()) client.destroy(); await Promise.allSettled([...this.#terminals.values()].map(item => this.#stop(item))); for (const pending of this.#clients.values()) (await pending.catch(() => undefined))?.end(); this.#clients.clear();this.#opening.clear();this.#connected.clear(); }
}

function terminalTiming(terminal: Terminal) {
  const observedAt = terminal.endedAt ?? Date.now();
  return { startedAt: new Date(terminal.startedAt).toISOString(), durationMs: observedAt - terminal.startedAt,
    lastOutputAt: terminal.lastOutputAt ? new Date(terminal.lastOutputAt).toISOString() : null,
    outputIdleMs: observedAt - (terminal.lastOutputAt ?? terminal.startedAt) };
}
