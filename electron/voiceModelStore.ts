import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadVoiceFile, extractVoiceFile, extractVoiceFiles, verifyVoiceFile } from './voiceModelDownload';
import { voiceModelManifest, voiceModelSources, voiceModelVersion, type VoiceModelArchive } from './voiceModelManifest';
import type { VoiceModelStatus } from './voiceTypes';
import { voiceModelLicenses } from './voiceModelLicenses';

export interface VoiceModelDefinition {
  version: string; model: string; sources: { title: string; url: string }[];
  archives: VoiceModelArchive[]; licenses: Record<string, string>; attribution: string;
}
const defaultDefinition = (): VoiceModelDefinition => ({ version: voiceModelVersion, model: 'SenseVoice Small (INT8)',
  sources: voiceModelSources, archives: voiceModelManifest(), licenses: voiceModelLicenses,
  attribution: 'SenseVoice Small by FunAudioLLM / Alibaba.\nONNX conversion and runtime by sherpa-onnx.\nONNX Runtime by Microsoft.\n' });

/** A user-triggered optional download. Construction/status never contact a server. */
export class VoiceModelStore {
  readonly directory: string;
  private archives: VoiceModelArchive[];
  private progress: Partial<VoiceModelStatus> = {};
  private job?: { controller: AbortController; promise: Promise<VoiceModelStatus> };
  private removal?: Promise<VoiceModelStatus>;
  private users = 0;
  private fingerprints = new Map<string, string>();
  constructor(private root: string, private fetcher: typeof fetch = fetch, private definition: VoiceModelDefinition = defaultDefinition()) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(definition.version)) throw Error('Invalid model version.');
    this.archives = definition.archives;
    this.root = path.resolve(root); this.directory = path.join(this.root, definition.version);
  }
  status(): VoiceModelStatus {
    const files = this.archives.flatMap(archive => archive.files);
    const installed = files.length > 0 && fs.existsSync(path.join(this.directory, 'installed.json')) && files.every(file => {
      try { const s = fs.lstatSync(path.join(this.directory, file.name)); return s.isFile() && !s.isSymbolicLink() && s.size === file.bytes; } catch { return false; }
    });
    return { supported: this.archives.length > 0, model: this.definition.model, version: this.definition.version,
      sources: this.definition.sources, downloadedBytes: 0, totalBytes: this.archives.reduce((sum, archive) => sum + archive.bytes, 0),
      state: installed ? 'installed' : 'not-installed', ...this.progress };
  }
  install(): Promise<VoiceModelStatus> {
    if (this.removal) return Promise.reject(Error('模型正在卸载，请稍后重试。'));
    if (this.job) return this.job.promise;
    if (!this.archives.length) return Promise.reject(Error('当前平台不支持这个可选语音模型。'));
    if (this.users) return Promise.reject(Error('语音模型正在使用，请结束语音任务后再安装。'));
    if (this.status().state === 'installed') return Promise.resolve(this.status());
    const controller = new AbortController();
    const promise = this.performInstall(controller.signal).finally(() => { this.job = undefined; });
    this.job = { controller, promise }; return promise;
  }
  async cancelInstall() { const job = this.job; job?.controller.abort(); await job?.promise; }
  remove(): Promise<VoiceModelStatus> {
    if (this.removal) return this.removal;
    this.removal = this.performRemove().finally(() => { this.removal = undefined; });
    return this.removal;
  }
  private async performRemove(): Promise<VoiceModelStatus> {
    await this.cancelInstall();
    if (this.users) throw Error('语音模型正在使用，请结束语音任务后再卸载。');
    await this.removeOwned(this.directory); this.fingerprints.clear(); this.progress = {}; return this.status();
  }
  private async removeOwned(directory: string) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== this.root || !path.basename(resolved).startsWith(this.definition.version)) throw Error('Invalid voice model directory.');
    await fs.promises.rm(resolved, { recursive: true, force: true });
  }
  private async performInstall(cancel: AbortSignal) {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(20 * 60_000)]);
    const staging = path.join(this.root, this.definition.version + '-staging-' + randomUUID());
    const backup = path.join(this.root, this.definition.version + '-old-' + randomUUID());
    let completed = 0, replaced = false;
    this.progress = { state: 'downloading', downloadedBytes: 0 }; this.fingerprints.clear();
    try {
      await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
      for (let i = 0; i < this.archives.length; i++) {
        const archive = this.archives[i], downloaded = path.join(staging, `download-${i}.tar.bz2`);
        this.progress.state = 'downloading';
        await downloadVoiceFile(archive, downloaded, this.fetcher, signal, bytes => { this.progress.downloadedBytes = completed + bytes; });
        this.progress.state = 'verifying';
        if (archive.format === 'raw') {
          if (archive.files.length !== 1 || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(archive.files[0].name)) throw Error('Invalid raw model file.');
          await verifyVoiceFile(downloaded, archive.files[0]);
          await fs.promises.copyFile(downloaded, path.join(staging, archive.files[0].name));
        }
        else if (archive.allFilesInOrder) await extractVoiceFiles(downloaded, staging, archive.files, signal);
        else for (const file of archive.files) await extractVoiceFile(downloaded, file.entry, path.join(staging, file.name), file, signal);
        await fs.promises.unlink(downloaded); completed += archive.bytes;
      }
      signal.throwIfAborted();
      for (const [name, text] of Object.entries(this.definition.licenses)) await fs.promises.writeFile(path.join(staging, name), text, { mode: 0o600 });
      await fs.promises.writeFile(path.join(staging, 'ATTRIBUTION.txt'), this.definition.attribution + this.definition.sources.map(source => source.url).join('\n'), { mode: 0o600 });
      await fs.promises.writeFile(path.join(staging, 'installed.json'), JSON.stringify({ version: this.definition.version, sources: this.definition.sources, installedAt: new Date().toISOString() }), { mode: 0o600 });
      signal.throwIfAborted();
      if (fs.existsSync(this.directory)) { await fs.promises.rename(this.directory, backup); replaced = true; }
      try { await fs.promises.rename(staging, this.directory); }
      catch (error) { if (replaced) await fs.promises.rename(backup, this.directory); throw error; }
      this.progress = {}; if (replaced) await this.removeOwned(backup);
    } catch (error) {
      this.progress = cancel.aborted ? {} : { state: 'error', error: signal.aborted ? '下载超时，请重试。' : error instanceof Error ? error.message : '模型安装失败，请重试。' };
    } finally { await this.removeOwned(staging); }
    return this.status();
  }
  /** Verify pinned file hashes before the first use, and again if any file changes. */
  async acquire() {
    if (this.job || this.removal || this.status().state !== 'installed') throw Error('本地语音模型未安装或不可用，请在语音设置中安装。');
    this.users++;
    try {
      for (const file of this.archives.flatMap(archive => archive.files)) {
        const target = path.join(this.directory, file.name), stat = await fs.promises.lstat(target);
        const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (this.fingerprints.get(target) !== fingerprint) { await verifyVoiceFile(target, file); this.fingerprints.set(target, fingerprint); }
      }
    } catch { this.users--; this.progress = { state: 'error', error: '本地模型完整性校验失败，请重新安装。' }; throw Error(this.progress.error); }
    let released = false;
    return { directory: this.directory, release: () => { if (!released) { released = true; this.users--; } } };
  }
}
