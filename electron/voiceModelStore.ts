import { uiText } from '@cardbush/platform/i18n';
import { NativeVoiceError, type NativeVoiceMessage } from './voiceUiError';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadVoiceFile, extractVoiceFile, extractVoiceFiles, verifyVoiceFile } from './voiceModelDownload';
import { voiceModelManifest, voiceModelSources, voiceModelVersion, type VoiceModelArchive } from './voiceModelManifest';
import type { VoiceModelStatus } from './voiceTypes';
import { voiceModelLicenses } from './voiceModelLicenses';
import { collectTemporaryDirectories, leaseTemporaryDirectory } from './cacheMaintenance';

export const collectVoiceModelStaging = (root: string) => collectTemporaryDirectories(root,
  /^[\w.-]+-staging-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, 24 * 60 * 60_000);

export interface VoiceModelDefinition {
  version: string; model: string; sources: ReadonlyArray<{ url: string } & ({ title: string } | { titleKey: NativeVoiceMessage })>;
  archives: VoiceModelArchive[]; licenses: Record<string, string>; attribution: string;
}
const defaultDefinition = (): VoiceModelDefinition => ({ version: voiceModelVersion, model: 'SenseVoice Small (INT8)',
  sources: voiceModelSources, archives: voiceModelManifest(), licenses: voiceModelLicenses,
  attribution: 'SenseVoice Small by FunAudioLLM / Alibaba.\nONNX conversion and runtime by sherpa-onnx.\nONNX Runtime by Microsoft.\n' });

/** A user-triggered optional download. Construction/status never contact a server. */
export class VoiceModelStore {
  readonly directory: string;
  private archives: VoiceModelArchive[];
  private progress: Partial<Omit<VoiceModelStatus, 'error'>> & { failure?: NativeVoiceError } = {};
  private job?: { controller: AbortController; promise: Promise<VoiceModelStatus> };
  private removal?: Promise<VoiceModelStatus>;
  private users = 0;
  private fingerprints = new Map<string, string>();
  constructor(private root: string, private fetcher: typeof fetch = fetch, private definition: VoiceModelDefinition = defaultDefinition(),
    private uiLanguage: () => string = () => 'en') {
    if (!/^[a-zA-Z0-9_.-]+$/.test(definition.version)) throw Error('Invalid model version.');
    this.archives = definition.archives;
    this.root = path.resolve(root); this.directory = path.join(this.root, definition.version);
  }
  status(): VoiceModelStatus {
    const files = this.archives.flatMap(archive => archive.files);
    const installed = files.length > 0 && fs.existsSync(path.join(this.directory, 'installed.json')) && files.every(file => {
      try { const s = fs.lstatSync(path.join(this.directory, file.name)); return s.isFile() && !s.isSymbolicLink() && s.size === file.bytes; } catch { return false; }
    });
    const { failure, ...progress } = this.progress;
    const language = this.uiLanguage();
    const t = uiText(language);
    return { supported: this.archives.length > 0, model: this.definition.model, version: this.definition.version,
      sources: this.definition.sources.map(source => ({ url: source.url, title: 'titleKey' in source ? t(source.titleKey) : source.title })), downloadedBytes: 0, totalBytes: this.archives.reduce((sum, archive) => sum + archive.bytes, 0),
      state: installed ? 'installed' : 'not-installed', ...progress, ...(failure ? { error: failure.describe(language) } : {}) };
  }
  install(): Promise<VoiceModelStatus> {
    if (this.removal) return Promise.reject(new NativeVoiceError('voiceNative.modelRemoving'));
    if (this.job) return this.job.promise;
    if (!this.archives.length) return Promise.reject(new NativeVoiceError('voiceNative.modelUnsupported'));
    if (this.users) return Promise.reject(new NativeVoiceError('voiceNative.modelBusyInstall'));
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
    if (this.users) throw new NativeVoiceError('voiceNative.modelBusyRemove');
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
    let release: (() => void) | undefined;
    this.progress = { state: 'downloading', downloadedBytes: 0 }; this.fingerprints.clear();
    try {
      await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
      release = await leaseTemporaryDirectory(staging);
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
      const failure = signal.aborted ? new NativeVoiceError('voiceNative.modelDownloadTimeout')
        : error instanceof NativeVoiceError ? error : new NativeVoiceError('voiceNative.modelInstallFailed');
      this.progress = cancel.aborted ? {} : { state: 'error', failure };
    } finally {
      try { await this.removeOwned(staging); }
      finally { release?.(); }
    }
    return this.status();
  }
  /** Verify pinned file hashes before the first use, and again if any file changes. */
  async acquire() {
    if (this.job || this.removal || this.status().state !== 'installed') throw new NativeVoiceError('voiceNative.modelUnavailable');
    this.users++;
    try {
      for (const file of this.archives.flatMap(archive => archive.files)) {
        const target = path.join(this.directory, file.name), stat = await fs.promises.lstat(target);
        const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (this.fingerprints.get(target) !== fingerprint) { await verifyVoiceFile(target, file); this.fingerprints.set(target, fingerprint); }
      }
    } catch {
      this.users--;
      const failure = new NativeVoiceError('voiceNative.modelIntegrityFailed');
      this.progress = { state: 'error', failure };
      throw failure;
    }
    let released = false;
    return { directory: this.directory, release: () => { if (!released) { released = true; this.users--; } } };
  }
}
