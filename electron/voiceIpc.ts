import { app, ipcMain, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { VoiceService } from './voiceService';
import { WindowsVoice } from './windowsVoice';
import { VoiceModelStore } from './voiceModelStore';
import { SenseVoice } from './senseVoice';
import { KokoroVoice } from './kokoroVoice';
import { kokoroDefinition } from './kokoroManifest';

async function completeOrCancel<T>(operation: Promise<T>, cancelled: T): Promise<T> {
  try { return await operation; }
  catch (error) { if (error instanceof Error && error.name === 'VoiceCancelledError') return cancelled; throw error; }
}

export function registerVoiceIpc(mainWindow: () => BrowserWindow | null, runtime: { packaged: boolean; appPath: string; resourcesPath: string }, network: { download: typeof fetch; speech: typeof fetch }) {
  let service: VoiceService | undefined;
  const models = new VoiceModelStore(path.join(app.getPath('userData'), 'voice-models'), network.download);
  const recognition = new SenseVoice(models, path.join(app.getPath('temp'), 'cardbush-voice'));
  const speechModels = new VoiceModelStore(path.join(app.getPath('userData'), 'voice-models'), network.download, kokoroDefinition());
  const speech = new KokoroVoice(speechModels, path.join(app.getPath('temp'), 'cardbush-voice'));
  const model = (kind: unknown) => { if (kind === 'speech') return speechModels; if (kind === undefined || kind === 'recognition') return models; throw Error('Invalid voice model kind.'); };
  app.once('before-quit', () => { void models.cancelInstall(); void speechModels.cancelInstall(); });
  const watched = new Set<number>();
  const authorized = (event: IpcMainInvokeEvent) => {
    const window = mainWindow();
    if (!window || window.isDestroyed() || window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw Error('Voice is only available in the main application.');
    if (!watched.has(event.sender.id)) {
      const owner = event.sender.id; watched.add(owner);
      event.sender.once('destroyed', () => { service?.cancelOwner(owner); watched.delete(owner); });
      event.sender.on('render-process-gone', () => service?.cancelOwner(owner));
    }
    return service ??= new VoiceService(path.join(app.getPath('userData'), 'voice-settings.json'), {
      recognition, speech,
      local: new WindowsVoice(runtime.packaged ? path.join(runtime.resourcesPath, 'voice', 'CardBushVoiceHost.exe')
        : path.join(runtime.appPath, 'dist-native', 'voice', 'CardBushVoiceHost.exe')),
      fetch: network.speech,
      encrypt: value => {
        if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw Error('系统安全凭据存储不可用。');
        return safeStorage.encryptString(value).toString('base64');
      },
      decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
    });
  };
  ipcMain.handle('voice:settings', event => authorized(event).settings());
  ipcMain.handle('voice:capabilities', event => authorized(event).capabilities());
  ipcMain.handle('voice:model-status', (event, kind) => { authorized(event); return model(kind).status(); });
  ipcMain.handle('voice:model-install', (event, kind) => { authorized(event); return model(kind).install(); });
  ipcMain.handle('voice:model-cancel', (event, kind) => { authorized(event); return model(kind).cancelInstall(); });
  ipcMain.handle('voice:model-remove', (event, kind) => {
    const settings = authorized(event).settings();
    if (kind === 'speech' ? settings.engine === 'kokoro' : settings.recognitionEngine === 'sensevoice') throw Error('请先选择并保存其他语音方式，再卸载本地模型。');
    return model(kind).remove();
  });
  ipcMain.handle('voice:save-settings', (event, input) => authorized(event).save(input));
  ipcMain.handle('voice:transcribe', (event, input) => completeOrCancel(authorized(event).transcribe(event.sender.id, input), { text: '' }));
  ipcMain.handle('voice:speak', (event, input) => completeOrCancel(authorized(event).speak(event.sender.id, input, chunk => {
    if (!event.sender.isDestroyed()) event.sender.send('voice:audio', chunk);
  }), undefined));
  ipcMain.handle('voice:cancel', (event, id) => authorized(event).cancel(event.sender.id, id));
}

/** Keep microphone permission limited to the application frame, never embedded HTML. */
export function installVoiceMediaPermissions(window: BrowserWindow) {
  const trusted = (contents: Electron.WebContents | null, isMainFrame: boolean, url?: string) =>
    !window.isDestroyed() && contents === window.webContents && isMainFrame && (!url || url === window.webContents.getURL());
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission !== 'media') return true; // Preserve Electron's existing handling of unrelated permissions.
    return trusted(contents, details.isMainFrame, details.requestingUrl) && details.mediaType === 'audio';
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(true); return; }
    const types = (details as Electron.MediaAccessPermissionRequest).mediaTypes;
    callback(trusted(contents, details.isMainFrame, details.requestingUrl) && Boolean(types?.length && types.every(type => type === 'audio')));
  });
}
