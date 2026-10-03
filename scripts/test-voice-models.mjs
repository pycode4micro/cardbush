import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { VoiceModelStore } from '../dist-electron/voiceModelStore.js';
import { downloadVoiceFile, extractVoiceFile } from '../dist-electron/voiceModelDownload.js';
import { VoiceService } from '../dist-electron/voiceService.js';
import { defaultVoiceSettings } from '../dist-electron/voiceTypes.js';
import { splitVoiceWave } from '../dist-electron/senseVoice.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = () => fs.mkdtempSync(path.resolve('tmp/voice-model-test-'));
const url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/test.tar.bz2';
const signal = () => AbortSignal.timeout(10000);

test('model discovery does not download, install or change defaults', () => {
  const root = path.join(temporary(), 'models'); let calls = 0;
  const store = new VoiceModelStore(root, async () => { calls++; throw Error('Unexpected network'); });
  assert.equal(store.status().state, 'not-installed'); assert.equal(calls, 0); assert.equal(fs.existsSync(root), false);
  assert.equal(defaultVoiceSettings.recognitionEngine, 'system');
});
test('downloads enforce trusted HTTPS redirects, size and SHA-256 before accepting files', async () => {
  const data = Buffer.from('official bytes'), asset = { url, bytes: data.length, sha256: digest(data) };
  const hosts = [], destination = path.join(temporary(), 'verified');
  await downloadVoiceFile(asset, destination, async (requestUrl, init) => {
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); hosts.push(new URL(requestUrl).hostname);
    if (hosts.length === 1) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixed-version' } });
    return new Response(data);
  }, signal(), () => {});
  assert.deepEqual(hosts, ['github.com', 'release-assets.githubusercontent.com']);assert.deepEqual(fs.readFileSync(destination), data);
  for (const body of [Buffer.from('modified bytes'), data.subarray(0, 2), Buffer.concat([data, data])]) {
    await assert.rejects(downloadVoiceFile(asset, path.join(temporary(), 'bad'), async () => new Response(body), signal(), () => {}), /大小|SHA-256/);
  }
  for (const redirect of ['https://evil.invalid/model', 'http://github.com/file', 'https://user:password@github.com/file']) {
    let calls = 0;
    await assert.rejects(downloadVoiceFile(asset, path.join(temporary(), 'bad'), async () => { calls++; return new Response(null, { status: 302, headers: { location: redirect } }); }, signal(), () => {}), /来源不受信任/);
    assert.equal(calls, 1);
  }
});
test('download failures keep proxy credentials private, preserve cancellation and bound redirect loops', async () => {
  const asset = { url, bytes: 5, sha256: digest(Buffer.from('model')) }, destination = path.join(temporary(), 'model');
  await assert.rejects(downloadVoiceFile(asset, destination, async () => { throw Error('proxy https://name:secret@proxy.invalid'); }, signal(), () => {}),
    error => /设置 → 网络/.test(error.message) && !/secret|name|proxy.invalid/.test(error.message));
  await assert.rejects(downloadVoiceFile(asset, destination, async () => new Response('credential from upstream', { status: 407 }), signal(), () => {}),
    error => /HTTP 407/.test(error.message) && !error.message.includes('credential'));
  let hops = 0;
  await assert.rejects(downloadVoiceFile(asset, destination, async (_url, options) => {
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit'); hops++;
    return new Response(null, { status: 302, headers: { location: url } });
  }, signal(), () => {}), /重定向次数/);
  assert.equal(hops, 6);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(downloadVoiceFile(asset, destination, async () => { throw Error('network'); }, cancelled.signal, () => {}), { name: 'AbortError' });
});

function fixture() {
  const root = temporary(), bytes = Buffer.from('recognizer fixture');
  fs.writeFileSync(path.join(root, 'model.bin'), bytes);
  const archive = path.join(root, 'archive.tar');
  const result = spawnSync('tar', ['-cf', archive, '-C', root, 'model.bin'], { windowsHide: true }); assert.equal(result.status, 0);
  const payload = fs.readFileSync(archive);
  const store = new VoiceModelStore(path.join(root, 'models'), async () => new Response(payload));
  // Supply a tiny pinned fixture archive; use the real downloader, extractor and lifecycle.
  store.archives = [{ url, bytes: payload.length, sha256: digest(payload), files: [{ name: 'model.bin', entry: 'model.bin', bytes: bytes.length, sha256: digest(bytes) }] }];
  return { store, root, payload };
}
test('installation is atomic, checks executable contents and blocks removal during use', async () => {
  const { store } = fixture();
  const installing = store.install(); assert.equal(store.install(), installing);
  assert.equal((await installing).state, 'installed');
  assert.ok(fs.existsSync(path.join(store.directory, 'FunASR-MODEL-LICENSE.txt')));
  const lease = await store.acquire(); await assert.rejects(store.remove(), /正在使用/); lease.release();
  fs.writeFileSync(path.join(store.directory, 'model.bin'), 'tampered fixture!!');
  await assert.rejects(store.acquire(), /完整|校验|不可用/);
  assert.equal((await store.remove()).state, 'not-installed');
});
test('failed or cancelled installation removes partial downloads without marking installed', async () => {
  const failed = fixture(); failed.store.archives[0].sha256 = '0'.repeat(64);
  assert.equal((await failed.store.install()).state, 'error'); assert.equal(fs.existsSync(failed.store.directory), false);
  assert.deepEqual(fs.readdirSync(path.join(failed.root, 'models')), []);
  const cancelled = fixture(); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  cancelled.store.fetcher = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(cancelled.payload.subarray(0, 10)); entered(); } }));
  const running = cancelled.store.install(); await started; await cancelled.store.cancelInstall(); await running;
  assert.equal(cancelled.store.status().state, 'not-installed'); assert.deepEqual(fs.readdirSync(path.join(cancelled.root, 'models')), []);
  await assert.rejects(extractVoiceFile('unused', '../outside', 'unused', { bytes: 1, sha256: '' }, signal()), /Invalid/);
});

test('uninstall excludes new recognition and installation until removal completes', async () => {
  const { store } = fixture(); await store.install();
  const remove = store.remove(); assert.equal(store.remove(), remove);
  await assert.rejects(store.acquire(), /不可用/);
  await assert.rejects(store.install(), /正在卸载/);
  assert.equal((await remove).state, 'not-installed');
  const reinstalled = await store.install(); assert.equal(reinstalled.state, 'installed', reinstalled.error);
  await store.remove();
});
test('recognition selection is independent of system/cloud speech and never silently falls back', async () => {
  let spoken = 0, recognized = 0, network = 0, decrypted = 0;
  const instance = new VoiceService(path.join(temporary(), 'voice.json'), {
    local: { speak: async () => { spoken++; }, transcribe: async () => { throw Error('Wrong legacy engine'); } },
    recognition: { transcribe: async () => { recognized++; return { text: '中 English' }; } },
    fetch: async () => { network++; throw Error('No network'); }, encrypt: key => key, decrypt: key => { decrypted++; return key; },
  });
  instance.save({ ...defaultVoiceSettings, recognitionEngine: 'sensevoice', apiKey: 'retained' });
  assert.deepEqual(await instance.transcribe(1, { id: 'local', audio: new ArrayBuffer(44), mimeType: 'audio/wav' }), { text: '中 English' });
  await instance.speak(1, { id: 'speech', text: '你好' }, () => {});
  assert.equal(recognized, 1); assert.equal(spoken, 1); assert.equal(network, 0); assert.equal(decrypted, 0);
  const missing = new VoiceService(path.join(temporary(), 'voice.json'), { fetch: async () => { network++; throw Error(); }, encrypt: String, decrypt: String });
  missing.save({ ...defaultVoiceSettings, recognitionEngine: 'sensevoice' });
  await assert.rejects(missing.transcribe(1, { id: 'missing', audio: new ArrayBuffer(44), mimeType: 'audio/wav' }), /安装本地识别/); assert.equal(network, 0);
});
test('long audio is bounded and split without losing or duplicating samples', () => {
  const rate = 16000, pcm = Buffer.alloc(rate * 2 * 65);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE((i * 7) % 30000, i);
  const wave = Buffer.alloc(44 + pcm.length); wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(rate, 24); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40); pcm.copy(wave, 44);
  const clips = splitVoiceWave(wave.buffer); assert.ok(clips.length >= 3); assert.ok(clips.every(clip => clip.length <= 44 + rate * 2 * 25));
  assert.deepEqual(Buffer.concat(clips.map(clip => clip.subarray(44))), pcm);
  awaitInvalid(wave);
});
function awaitInvalid(wave) { const invalid = Buffer.from(wave); invalid.writeUInt16LE(2, 22); assert.throws(() => splitVoiceWave(invalid.buffer.slice(invalid.byteOffset, invalid.byteOffset + invalid.length)), /单声道/); }
import {extractVoiceFiles} from '../dist-electron/voiceModelDownload.js';
import {kokoroDefinition} from '../dist-electron/kokoroManifest.js';
import {kokoroPcm} from '../dist-electron/kokoroVoice.js';
test('pinned multi-file extraction verifies every byte in one pass, no archive paths are written', async () => {
  const root = temporary();fs.mkdirSync(path.join(root,'nested'));
  const a=Buffer.from('hello'),b=Buffer.from('world'),empty=Buffer.alloc(0);
  fs.writeFileSync(path.join(root,'first'),a);fs.writeFileSync(path.join(root,'nested','Mr serious'),b);fs.writeFileSync(path.join(root,'empty'),empty);
  const archive=path.join(root,'all.tar');assert.equal(spawnSync('tar',['-cf',archive,'-C',root,'first','empty','nested/Mr serious'],{windowsHide:true}).status,0);
  const files=[['first','model.bin',a],['empty','empty',empty],['nested/Mr serious','data/Mr serious',b]].map(([entry,name,bytes])=>({entry,name,bytes:bytes.length,sha256:digest(bytes)}));
  const out=path.join(root,'verified');await extractVoiceFiles(archive,out,files,signal());
  assert.equal(fs.readFileSync(path.join(out,'data/Mr serious'),'utf8'),'world');assert.equal(fs.existsSync(path.join(out,'nested')),false);
  for(const name of ['../escape','../','/outside','C:/outside','a/../escape','a./file'])await assert.rejects(extractVoiceFiles(archive,path.join(root,'bad'),[{...files[0],name}],signal()),/Invalid/);
  await assert.rejects(extractVoiceFiles(archive,path.join(root,'corrupt'),[{...files[0],sha256:'0'.repeat(64)},...files.slice(1)],signal()),/SHA-256/);
  await assert.rejects(extractVoiceFiles(archive,path.join(root,'truncated'),files.slice(0,1),signal()),/超出/);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(extractVoiceFiles(archive,path.join(root,'cancelled'),files,cancelled.signal));
});
test('neural voice manifest is separately optional and WAV format is validated', () => {
  assert.equal(kokoroDefinition('linux','x64').archives.length,0);
  const definition=kokoroDefinition('win32','x64'), root=path.join(temporary(),'models');let network=0;
  const store=new VoiceModelStore(root,async()=>{network++;throw Error('no');},definition);
  assert.equal(store.status().model,'Kokoro v1.1 (INT8)');assert.equal(store.status().state,'not-installed');assert.equal(network,0);assert.equal(fs.existsSync(root),false);
  const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
  assert.equal(kokoroPcm(wav).length,4);wav.writeUInt16LE(2,22);assert.throws(()=>kokoroPcm(wav),/PCM/);assert.throws(()=>kokoroPcm(Buffer.from('bad')),/格式/);
});
