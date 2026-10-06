import { app, dialog, ipcMain, safeStorage, powerSaveBlocker, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { VoiceService } from './voiceService';
import { WindowsVoice } from './windowsVoice';
import { VoiceModelStore } from './voiceModelStore';
import { SenseVoice } from './senseVoice';
import { KokoroVoice } from './kokoroVoice';
import { kokoroDefinition } from './kokoroManifest';
import { speakerDefinition } from './speakerManifest';
import { SpeakerEmbedding } from './speakerEmbedding';
import { SpeakerLock } from './speakerLock';
import { CustomSpeech } from './customSpeech';
import { RealtimeVoiceService, connectRealtimeVoice } from './realtimeVoiceService';

async function completeOrCancel<T>(operation: Promise<T>, cancelled: T): Promise<T> {
  try { return await operation; }
  catch (error) { if (error instanceof Error && error.name === 'VoiceCancelledError') return cancelled; throw error; }
}

export function registerVoiceIpc(mainWindow: () => BrowserWindow | null, runtime: { packaged: boolean; appPath: string; resourcesPath: string }, network: { download: typeof fetch; speech: typeof fetch; realtimeProxy: () => Promise<string> }) {
  let service: VoiceService | undefined;
  const models = new VoiceModelStore(path.join(app.getPath('userData'), 'voice-models'), network.download);
  const recognition = new SenseVoice(models, path.join(app.getPath('temp'), 'cardbush-voice'));
  const speechModels = new VoiceModelStore(path.join(app.getPath('userData'), 'voice-models'), network.download, kokoroDefinition());
  const speech = new KokoroVoice(speechModels, path.join(app.getPath('temp'), 'cardbush-voice'));
  const customSpeech = new CustomSpeech(speech, () => speechModels.status().state === 'installed', runtime.packaged
    ? path.join(runtime.resourcesPath, 'voice', 'custom_tts.py') : path.join(runtime.appPath, 'native', 'voice', 'custom_tts.py'));
  const speakerModels = new VoiceModelStore(path.join(app.getPath('userData'), 'voice-models'), network.download, speakerDefinition());
  const crypto = {
    encrypt: (value: string) => {
      if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw Error('系统安全凭据存储不可用。');
      return safeStorage.encryptString(value).toString('base64');
    }, decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
  const speaker = new SpeakerLock(path.join(app.getPath('userData'), 'voice-speaker-profile.json'), new SpeakerEmbedding(speakerModels,
    runtime.packaged ? path.join(runtime.resourcesPath, 'voice', 'CardBushSpeakerHost.exe') : path.join(runtime.appPath, 'dist-native', 'voice', 'CardBushSpeakerHost.exe')), crypto,
    () => speakerModels.status().state === 'installed');
  const realtime = new RealtimeVoiceService(path.join(app.getPath('userData'), 'voice-realtime-settings.json'), {
    ...crypto, connect: async (url, headers) => connectRealtimeVoice(await network.realtimeProxy(), url, headers),
  });
  const model = (kind: unknown) => { if (kind === 'speaker') return speakerModels; if (kind === 'speech') return speechModels; if (kind === undefined || kind === 'recognition') return models; throw Error('Invalid voice model kind.'); };
  app.once('before-quit', () => {
    realtime.closeAll();
    for (const owner of watched) service?.cancelOwner(owner);
    void models.cancelInstall(); void speechModels.cancelInstall(); void speakerModels.cancelInstall();
  });
  const watched = new Set<number>();
  const callBlockers = new Map<number, number>();
  const releaseCall = (owner: number) => { const blocker = callBlockers.get(owner); if (blocker !== undefined) powerSaveBlocker.stop(blocker); callBlockers.delete(owner); };
  app.once('before-quit', () => { for (const owner of callBlockers.keys()) releaseCall(owner); });
  const authorized = (event: IpcMainInvokeEvent) => {
    const window = mainWindow();
    if (!window || window.isDestroyed() || window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw Error('Voice is only available in the main application.');
    if (!watched.has(event.sender.id)) {
      const owner = event.sender.id; watched.add(owner);
      event.sender.once('destroyed', () => { service?.cancelOwner(owner); realtime.close(owner); releaseCall(owner); watched.delete(owner); });
      event.sender.on('render-process-gone', () => { service?.cancelOwner(owner); realtime.close(owner); releaseCall(owner); });
    }
    return service ??= new VoiceService(path.join(app.getPath('userData'), 'voice-settings.json'), {
      recognition, speech, speaker, customSpeech,
      local: new WindowsVoice(runtime.packaged ? path.join(runtime.resourcesPath, 'voice', 'CardBushVoiceHost.exe')
        : path.join(runtime.appPath, 'dist-native', 'voice', 'CardBushVoiceHost.exe')),
      fetch: network.speech,
      ...crypto,
    });
  };
  ipcMain.handle('voice:settings', event => authorized(event).settings());
  ipcMain.handle('voice:call-active', (event, active) => {
    authorized(event);
    if (typeof active !== 'boolean') throw Error('Invalid call state.');
    if (!active) releaseCall(event.sender.id);
    else if (!callBlockers.has(event.sender.id)) callBlockers.set(event.sender.id, powerSaveBlocker.start('prevent-app-suspension'));
  });
  ipcMain.handle('voice:realtime-settings', event => { authorized(event); return realtime.settings(); });
  ipcMain.handle('voice:realtime-save', (event, input) => { authorized(event); return realtime.save(input); });
  ipcMain.handle('voice:realtime-start', (event, input) => {
    authorized(event);
    if (speaker.status().enabled) throw Error('实时通话不支持声纹锁定，请关闭锁定或选择「转写 + Agent + 朗读」模式。');
    return realtime.start(event.sender.id, input, update => { if (!event.sender.isDestroyed()) event.sender.send('voice:realtime-event', update); });
  });
  ipcMain.handle('voice:realtime-audio', (event, id, pcm) => { authorized(event); return realtime.audio(event.sender.id, id, pcm); });
  ipcMain.handle('voice:realtime-control', (event, id, action) => { authorized(event); return realtime.control(event.sender.id, id, action); });
  ipcMain.handle('voice:realtime-results', (event, id, results) => { authorized(event); return realtime.results(event.sender.id, id, results); });
  ipcMain.handle('voice:realtime-notify', (event, id, result) => { authorized(event); return realtime.notify(event.sender.id, id, result); });
  ipcMain.handle('voice:realtime-compacted', (event, id, jobId, result) => { authorized(event); return realtime.compacted(event.sender.id, id, jobId, result); });
  ipcMain.handle('voice:realtime-playback', (event, id, speaking) => { authorized(event); return realtime.playback(event.sender.id, id, speaking); });
  ipcMain.handle('voice:realtime-forget-history', (event, sessionId) => { authorized(event); return realtime.forgetHistory(sessionId); });
  ipcMain.handle('voice:realtime-voice', (event, id, voice) => { authorized(event); return realtime.setVoice(event.sender.id, id, voice); });
  ipcMain.handle('voice:realtime-close', (event, id) => { authorized(event); realtime.close(event.sender.id, id); });
  ipcMain.handle('voice:choose-speech-path', async (event, kind) => {
    authorized(event);
    if (kind !== 'model' && kind !== 'python') throw Error('Invalid speech path kind.');
    const result = await dialog.showOpenDialog(mainWindow()!, {
      title: kind === 'model' ? '选择本地语音模型目录' : '选择已安装 qwen-tts 的 Python 解释器',
      properties: [kind === 'model' ? 'openDirectory' : 'openFile'],
      ...(kind === 'python' && process.platform === 'win32' ? { filters: [{ name: 'Python', extensions: ['exe'] }] } : {}),
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('voice:inspect-speech-model', (event, directory) => { authorized(event); return customSpeech.inspect(directory); });
  ipcMain.handle('voice:capabilities', event => authorized(event).capabilities());
  ipcMain.handle('voice:model-status', (event, kind) => { authorized(event); return model(kind).status(); });
  ipcMain.handle('voice:model-install', (event, kind) => { authorized(event); return model(kind).install(); });
  ipcMain.handle('voice:model-cancel', (event, kind) => { authorized(event); return model(kind).cancelInstall(); });
  ipcMain.handle('voice:model-remove', (event, kind) => {
    const settings = authorized(event).settings();
    let customKokoro = false;
    if (kind === 'speech' && settings.engine === 'custom') {
      try { customKokoro = customSpeech.inspect(settings.customSpeech?.directory ?? '').kind === 'kokoro'; } catch { /* A removed directory must not trap the user in an unusable setup. */ }
    }
    if (kind === 'speaker' ? speaker.status().enabled : kind === 'speech' ? settings.engine === 'kokoro' || customKokoro : settings.recognitionEngine === 'sensevoice') throw Error('请先关闭声纹锁定或选择并保存其他语音方式，再卸载本地模型。');
    return model(kind).remove();
  });
  ipcMain.handle('voice:save-settings', (event, input) => authorized(event).save(input));
  ipcMain.handle('voice:speaker-status', event => authorized(event).speakerStatus());
  ipcMain.handle('voice:speaker-enroll', (event, input) => authorized(event).enrollSpeaker(event.sender.id, input));
  ipcMain.handle('voice:speaker-configure', (event, input) => {
    const status = authorized(event).configureSpeaker(input);
    if (status.enabled) realtime.closeAll();
    return status;
  });
  ipcMain.handle('voice:speaker-remove', (event, profileId) => authorized(event).removeSpeaker(profileId));
  ipcMain.handle('voice:speaker-profile-save', (event, input) => authorized(event).saveSpeakerProfile(input));
  ipcMain.handle('voice:speaker-profile-select', (event, profileId) => authorized(event).selectSpeakerProfile(profileId));
  ipcMain.handle('voice:speaker-sample-save', (event, input) => authorized(event).saveSpeakerSample(event.sender.id, input));
  ipcMain.handle('voice:speaker-sample-remove', (event, input) => authorized(event).removeSpeakerSample(input));
  ipcMain.handle('voice:transcribe', (event, input) => completeOrCancel(authorized(event).transcribe(event.sender.id, input), { text: '' }));
  ipcMain.handle('voice:speak', (event, input) => completeOrCancel(authorized(event).speak(event.sender.id, input, chunk => {
    if (!event.sender.isDestroyed()) event.sender.send('voice:audio', chunk);
  }), undefined));
  ipcMain.handle('voice:cancel', (event, id) => authorized(event).cancel(event.sender.id, id));
}
