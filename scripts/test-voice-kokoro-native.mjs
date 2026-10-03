import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {VoiceModelStore} from '../dist-electron/voiceModelStore.js';
import {kokoroDefinition} from '../dist-electron/kokoroManifest.js';
import {KokoroVoice} from '../dist-electron/kokoroVoice.js';
import {SenseVoice} from '../dist-electron/senseVoice.js';
import {defaultVoiceSettings} from '../dist-electron/voiceTypes.js';
import {defaultCustomSpeechSettings} from '../dist-electron/voiceTypes.js';
import {CustomSpeech} from '../dist-electron/customSpeech.js';
// Explicit native regression: no automatic download. Use already-verified upstream cache.
if(process.platform!=='win32'||process.arch!=='x64'){console.log('SKIP Kokoro native regression: Windows x64 only.');process.exit(0);}
const cache=path.resolve('tmp/kokoro-upstream');
if(!['model.tar.bz2','runtime.tar.bz2'].every(f=>fs.existsSync(path.join(cache,f)))){console.log('SKIP Kokoro native regression: optional upstream cache absent.');process.exit(0);}
const root=path.resolve('tmp/kokoro-native-models'),scratch=path.resolve('tmp/kokoro-native-audio');
const store=new VoiceModelStore(root,async(url)=>{const f=path.join(cache,String(url).includes('tts-models')?'model.tar.bz2':'runtime.tar.bz2');return new Response(Readable.toWeb(fs.createReadStream(f)),{headers:{'content-length':String(fs.statSync(f).size)}});},kokoroDefinition());
assert.equal((await store.install()).state,'installed',store.status().error);
const backend=new KokoroVoice(store,scratch),config={...defaultVoiceSettings,engine:'kokoro'};
const recognizerStore=new VoiceModelStore(path.join(process.env.APPDATA,'cardbush','voice-models'));
const recognizer=recognizerStore.status().state==='installed'?new SenseVoice(recognizerStore,scratch):undefined;
const reports=[];
for(const voice of ['female','male']){
 const chunks=[],start=performance.now();
 await backend.speak({id:'sample-'+voice,text:'你好，我先核对一下最新行情。',voice},config,AbortSignal.timeout(60000),v=>chunks.push(Buffer.from(v.pcm,'base64')));
 const elapsedMs=Math.round(performance.now()-start),pcm=Buffer.concat(chunks);
 assert.ok(pcm.length>48000);
 const wav=Buffer.alloc(44+pcm.length);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);
 fs.writeFileSync(path.resolve('tmp/voice-kokoro-'+voice+'.wav'),wav);
 const recognized=recognizer?await recognizer.transcribe(wav.buffer,config,AbortSignal.timeout(30000)):undefined;
 if(recognized)assert.match(recognized.text,/行情/);
 reports.push({voice,elapsedMs,durationMs:Math.round(pcm.length/48),recognized:recognized?.text});
 console.log(reports.at(-1));
}
const cancel=new AbortController();const running=backend.speak({id:'cancel',text:'取消这次播放。'},config,cancel.signal,()=>assert.fail('cancelled speech emitted'));
setTimeout(()=>cancel.abort(),200);await assert.rejects(running);assert.deepEqual(fs.readdirSync(scratch),[]);
// An external model folder contains only data plus a deliberately invalid executable.
// Successful synthesis proves the adapter still executes the verified installed runtime.
const imported=fs.mkdtempSync(path.resolve('tmp/custom-kokoro-'));
for(const name of ['model.int8.onnx','voices.bin','tokens.txt','lexicon-us-en.txt','lexicon-zh.txt','date-zh.fst','number-zh.fst','phone-zh.fst']) fs.linkSync(path.join(store.directory,name),path.join(imported,name));
fs.symlinkSync(path.join(store.directory,'espeak-ng-data'),path.join(imported,'espeak-ng-data'),'junction');
fs.writeFileSync(path.join(imported,'sherpa-onnx-offline-tts.exe'),'not executable');
const custom=new CustomSpeech(backend,()=>true,'unused'),customChunks=[];
await custom.speak({id:'custom-kokoro',text:'你好，我在听。',voice:'male'}, {...config,engine:'custom',customSpeech:{...defaultCustomSpeechSettings,directory:imported}}, AbortSignal.timeout(60000), chunk=>customChunks.push(Buffer.from(chunk.pcm,'base64')));
assert.ok(Buffer.concat(customChunks).length>48000);assert.equal(fs.readFileSync(path.join(imported,'sherpa-onnx-offline-tts.exe'),'utf8'),'not executable');
assert.deepEqual(fs.readdirSync(scratch),[]);console.log('Custom Kokoro uses imported data with the verified runtime; imported files stay intact.');
fs.writeFileSync('tmp/voice-kokoro-benchmark.json',JSON.stringify(reports,null,2));
console.log('Pinned install, female/male real PCM, cancellation and scratch cleanup passed. User engine selection unchanged.');
