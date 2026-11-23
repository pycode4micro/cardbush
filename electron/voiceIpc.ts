import { NativeVoiceError } from './voiceUiError';
import { app, dialog, ipcMain, safeStorage, powerSaveBlocker, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { uiText } from '@cardbush/platform/i18n';
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
import { RealtimeVoiceService, connectRealtimeVoice, type RealtimeVoiceDiagnostic } from './realtimeVoiceService';

async function completeOrCancel<T>(operation: Promise<T>, cancelled: T): Promise<T> {
  try { return await operation; }
  catch (error) { if (error instanceof Error && error.name === 'VoiceCancelledError') return cancelled; throw error; }
}

export function registerVoiceIpc(windowForSender: (sender: Electron.WebContents) => BrowserWindow | null, runtime: { packaged: boolean; appPath: string; resourcesPath: string }, network: { download: typeof fetch; speech: typeof fetch; realtimeProxy: () => Promise<string>; realtimeDiagnostic?: (entry: RealtimeVoiceDiagnostic) => void; uiLanguage?: () => string; environment?: import('./realtimeVoiceService').RealtimeEnvironmentHost }) {
  let service: VoiceService | undefined;
  const language = () => network.uiLanguage?.() ?? app.getLocale();
  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try { return await listener(event, ...args); }
      catch (error) {
        if (error instanceof NativeVoiceError) throw new Error(error.describe(language()), { cause: error });
        throw error;
      }
    });
  };
  const models = new VoiceModelStore(path.join(app.getPath('userData'), 'voice-models'), network.download, undefined, language);
  const recognition = new SenseVoice(models, path.join(app.getPath('temp'), 'cardbush-voice'));
  const speechModels = new VoiceModelStore(path.join(app.getPath('userData'), 'voice-models'), network.download, kokoroDefinition(), language);
  const speech = new KokoroVoice(speechModels, path.join(app.getPath('temp'), 'cardbush-voice'));
  const customSpeech = new CustomSpeech(speech, () => speechModels.status().state === 'installed', runtime.packaged
    ? path.join(runtime.resourcesPath, 'voice', 'custom_tts.py') : path.join(runtime.appPath, 'native', 'voice', 'custom_tts.py'));
  const speakerModels = new VoiceModelStore(path.join(app.getPath('userData'), 'voice-models'), network.download, speakerDefinition(), language);
  const crypto = {
    encrypt: (value: string) => {
      if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new NativeVoiceError('voiceNative.secureStorageUnavailable');
      return safeStorage.encryptString(value).toString('base64');
    }, decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
  const speaker = new SpeakerLock(path.join(app.getPath('userData'), 'voice-speaker-profile.json'), new SpeakerEmbedding(speakerModels,
    runtime.packaged ? path.join(runtime.resourcesPath, 'voice', 'CardBushSpeakerHost.exe') : path.join(runtime.appPath, 'dist-native', 'voice', 'CardBushSpeakerHost.exe')), crypto,
    () => speakerModels.status().state === 'installed', language);
  const realtime = new RealtimeVoiceService(path.join(app.getPath('userData'), 'voice-realtime-settings.json'), {
    ...crypto, connect: async (url, headers) => connectRealtimeVoice(await network.realtimeProxy(), url, headers),
    diagnostic: network.realtimeDiagnostic,
    environment: network.environment,
    uiLanguage: language,
  });
  const model = (kind: unknown) => { if (kind === 'speaker') return speakerModels; if (kind === 'speech') return speechModels; if (kind === undefined || kind === 'recognition') return models; throw new NativeVoiceError('voiceNative.invalidModelKind'); };
  app.once('before-quit', () => {
    realtime.closeAll();
    for (const owner of watched) service?.cancelOwner(owner);
    void models.cancelInstall(); void speechModels.cancelInstall(); void speakerModels.cancelInstall();
  });
  const watched = new Set<number>();
  const callBlockers = new Map<number, number>();
  const releaseCall = (owner: number) => { const blocker = callBlockers.get(owner); if (blocker !== undefined) powerSaveBlocker.stop(blocker); callBlockers.delete(owner); };
  app.once('before-quit', () => { for (const owner of callBlockers.keys()) releaseCall(owner); });
  const currentService = () => service ??= new VoiceService(path.join(app.getPath('userData'), 'voice-settings.json'), {
    recognition, speech, speaker, customSpeech,
    local: new WindowsVoice(runtime.packaged ? path.join(runtime.resourcesPath, 'voice', 'CardBushVoiceHost.exe')
      : path.join(runtime.appPath, 'dist-native', 'voice', 'CardBushVoiceHost.exe')),
    fetch: network.speech,
    ...crypto,
  });
  const authorized = (event: IpcMainInvokeEvent) => {
    const window = windowForSender(event.sender);
    if (!window || window.isDestroyed() || window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new NativeVoiceError('voiceNative.mainWindowRequired');
    if (!watched.has(event.sender.id)) {
      const owner = event.sender.id; watched.add(owner);
      event.sender.once('destroyed', () => { service?.cancelOwner(owner); realtime.close(owner); releaseCall(owner); watched.delete(owner); });
      event.sender.on('render-process-gone', () => { service?.cancelOwner(owner); realtime.close(owner); releaseCall(owner); });
    }
    return currentService();
  };
  handle('voice:settings', event => authorized(event).settings());
  handle('voice:call-active', (event, active) => {
    authorized(event);
    if (typeof active !== 'boolean') throw new NativeVoiceError('voiceNative.invalidCallState');
    if (!active) releaseCall(event.sender.id);
    else if (!callBlockers.has(event.sender.id)) {
      if (callBlockers.size) throw Error(uiText(language())('resident.otherVoiceCall'));
      callBlockers.set(event.sender.id, powerSaveBlocker.start('prevent-app-suspension'));
    }
  });
  handle('voice:realtime-settings', event => { authorized(event); return realtime.settings(); });
  handle('voice:realtime-save', (event, input) => { authorized(event); return realtime.save(input); });
  handle('voice:realtime-save-voices', (event, input) => { authorized(event); return realtime.saveVoices(input); });
  handle('voice:realtime-start', (event, input) => {
    authorized(event);
    if (speaker.status().enabled) throw new NativeVoiceError('voiceNative.realtimeSpeakerLock');
    return realtime.start(event.sender.id, input, update => { if (!event.sender.isDestroyed()) event.sender.send('voice:realtime-event', update); });
  });
  handle('voice:realtime-audio', (event, id, pcm) => { authorized(event); return realtime.audio(event.sender.id, id, pcm); });
  handle('voice:realtime-control', (event, id, action) => { authorized(event); return realtime.control(event.sender.id, id, action); });
  handle('voice:realtime-sync-text', (event, id, sessionId, snapshot) => { authorized(event); return realtime.syncText(event.sender.id, id, sessionId, snapshot); });
  handle('voice:realtime-history', (event, id, cursor) => { authorized(event); return realtime.history(event.sender.id, id, cursor); });
  handle('voice:realtime-results', (event, id, results) => { authorized(event); return realtime.results(event.sender.id, id, results); });
  handle('voice:realtime-notify', (event, id, result) => { authorized(event); return realtime.notify(event.sender.id, id, result); });
  handle('voice:realtime-compacted', (event, id, jobId, result) => { authorized(event); return realtime.compacted(event.sender.id, id, jobId, result); });
  handle('voice:realtime-playback', (event, id, speaking) => { authorized(event); return realtime.playback(event.sender.id, id, speaking); });
  handle('voice:realtime-forget-history', (event, sessionId) => { authorized(event); return realtime.forgetHistory(sessionId); });
  handle('voice:realtime-voice', (event, id, voice) => { authorized(event); return realtime.setVoice(event.sender.id, id, voice); });
  handle('voice:realtime-close', (event, id) => { authorized(event); realtime.close(event.sender.id, id); });
  handle('voice:choose-speech-path', async (event, kind) => {
    authorized(event);
    if (kind !== 'model' && kind !== 'python') throw new NativeVoiceError('voiceNative.invalidPathKind');
    const result = await dialog.showOpenDialog(windowForSender(event.sender)!, {
      title: uiText(language())(kind === 'model' ? 'voiceNative.chooseModel' : 'voiceNative.choosePython'),
      properties: [kind === 'model' ? 'openDirectory' : 'openFile'],
      ...(kind === 'python' && process.platform === 'win32' ? { filters: [{ name: 'Python', extensions: ['exe'] }] } : {}),
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('voice:inspect-speech-model', (event, directory) => { authorized(event); return customSpeech.inspect(directory); });
  handle('voice:capabilities', event => authorized(event).capabilities(language()));
  handle('voice:model-status', (event, kind) => { authorized(event); return model(kind).status(); });
  handle('voice:model-install', (event, kind) => { authorized(event); return model(kind).install(); });
  handle('voice:model-cancel', (event, kind) => { authorized(event); return model(kind).cancelInstall(); });
  handle('voice:model-remove', (event, kind) => {
    const settings = authorized(event).settings();
    let customKokoro = false;
    if (kind === 'speech' && settings.engine === 'custom') {
      try { customKokoro = customSpeech.inspect(settings.customSpeech?.directory ?? '').kind === 'kokoro'; } catch { /* A removed directory must not trap the user in an unusable setup. */ }
    }
    if (kind === 'speaker' ? speaker.status().enabled : kind === 'speech' ? settings.engine === 'kokoro' || customKokoro : settings.recognitionEngine === 'sensevoice') throw new NativeVoiceError('voiceNative.removeInUseModel');
    return model(kind).remove();
  });
  handle('voice:save-settings', (event, input) => authorized(event).save(input));
  handle('voice:speaker-status', event => authorized(event).speakerStatus());
  handle('voice:speaker-enroll', (event, input) => authorized(event).enrollSpeaker(event.sender.id, input));
  handle('voice:speaker-configure', (event, input) => {
    const status = authorized(event).configureSpeaker(input);
    if (status.enabled) realtime.closeAll();
    return status;
  });
  handle('voice:speaker-remove', (event, profileId) => authorized(event).removeSpeaker(profileId));
  handle('voice:speaker-profile-save', (event, input) => authorized(event).saveSpeakerProfile(input));
  handle('voice:speaker-profile-select', (event, profileId) => authorized(event).selectSpeakerProfile(profileId));
  handle('voice:speaker-sample-save', (event, input) => authorized(event).saveSpeakerSample(event.sender.id, input));
  handle('voice:speaker-sample-remove', (event, input) => authorized(event).removeSpeakerSample(input));
  handle('voice:transcribe', (event, input) => completeOrCancel(authorized(event).transcribe(event.sender.id, input), { text: '' }));
  handle('voice:speak', (event, input) => completeOrCancel(authorized(event).speak(event.sender.id, input, chunk => {
    if (!event.sender.isDestroyed()) event.sender.send('voice:audio', chunk);
  }), undefined));
  handle('voice:cancel', (event, id) => authorized(event).cancel(event.sender.id, id));
  return { realtime, hasActiveCall: (owner: number) => callBlockers.has(owner), settings: () => currentService().settings() };
}
