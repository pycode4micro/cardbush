import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { SpeakerLock } from '../dist-electron/speakerLock.js';
import { SpeakerAudioUncertain, speakerAudioWindows, normalizeSpeakerVector } from '../dist-electron/speakerEmbedding.js';
import { speakerDefinition } from '../dist-electron/speakerManifest.js';
import { VoiceModelStore } from '../dist-electron/voiceModelStore.js';
import { VoiceService } from '../dist-electron/voiceService.js';
import { defaultVoiceSettings } from '../dist-electron/voiceTypes.js';

const signal = () => AbortSignal.timeout(3000);
const first = normalizeSpeakerVector(Array.from({length:32}, (_,i)=>i===0 ? 1 : .01));
const other = normalizeSpeakerVector(Array.from({length:32}, (_,i)=>i===1 ? 1 : .01));
const clips = () => [1,2,3].map(seed => { const bytes=new Uint8Array(80);bytes[44]=seed;return bytes.buffer; });
const deferred = () => { let resolve; const promise=new Promise(yes=>resolve=yes);return {promise,resolve}; };
function fixture(extract=async()=>({vectors:[first],voicedSeconds:6})) {
  const root=fs.mkdtempSync(path.resolve('tmp/speaker-lock-')), file=path.join(root,'profile.json'), key=randomBytes(32);
  const crypto={encrypt(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64');},
    decrypt(value){const data=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));c.setAuthTag(data.subarray(12,28));return Buffer.concat([c.update(data.subarray(28)),c.final()]).toString();}};
  const backend={extract};let installed=true;
  const lock=new SpeakerLock(file,backend,crypto,()=>installed);
  return {root,file,crypto,backend,lock,setInstalled(value){installed=value;}};
}
async function enroll(f) {await f.lock.enroll(clips(),signal()); f.lock.configure({enabled:true,mode:'strict'});}

test('speaker model is optional, Windows x64 only, pinned and has no startup download',()=>{
  let downloads=0;const f=fixture();const store=new VoiceModelStore(f.root,async()=>{downloads++;throw Error();},speakerDefinition());
  assert.equal(store.status().state,'not-installed');assert.equal(downloads,0);
  assert.deepEqual(speakerDefinition('linux','x64').archives,[]);assert.deepEqual(speakerDefinition('win32','arm64').archives,[]);
  for(const item of speakerDefinition().archives) {assert.match(item.url,/^https:\/\/github.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);assert.match(item.sha256,/^[a-f0-9]{64}$/);}
  for(const license of Object.values(speakerDefinition().licenses)) assert.ok(license?.length>100);
  assert.deepEqual(f.lock.status(),{enabled:false,mode:'strict',enrolled:false,enrolledAt:undefined,activeProfileId:undefined,profiles:[]});
});
test('raw model download preserves pinning, cancellation and on-use integrity checks',async()=>{
  const f=fixture(), bytes=Buffer.from('small optional model fixture'), sha256=createHash('sha256').update(bytes).digest('hex');
  const definition={version:'test-speaker',model:'fixture',sources:[],licenses:{},attribution:'fixture',archives:[{url:'https://github.com/example/model.onnx',bytes:bytes.length,sha256,format:'raw',files:[{name:'model.onnx',entry:'model.onnx',bytes:bytes.length,sha256}]}]};
  const store=new VoiceModelStore(f.root,async()=>new Response(bytes),definition);
  assert.equal((await store.install()).state,'installed');const lease=await store.acquire();assert.equal(fs.readFileSync(path.join(lease.directory,'model.onnx'),'utf8'),bytes.toString());lease.release();
  fs.writeFileSync(path.join(store.directory,'model.onnx'),Buffer.alloc(bytes.length));await assert.rejects(store.acquire(),/校验/);
  await store.remove();definition.archives[0].sha256='0'.repeat(64);const bad=new VoiceModelStore(f.root,async()=>new Response(bytes),definition);assert.equal((await bad.install()).state,'error');assert.ok(!fs.existsSync(bad.directory));
});
test('enrollment requires three consistent samples, stores encrypted features and does not enable itself',async()=>{
  const f=fixture();await assert.rejects(f.lock.enroll(clips().slice(0,2),signal()),/三段/);
  await assert.rejects(f.lock.enroll([clips()[0],clips()[0],clips()[0]],signal()),/不同/);
  const result=await f.lock.enroll(clips(),signal());assert.equal(result.enabled,false);assert.equal(result.enrolled,true);
  const disk=fs.readFileSync(f.file,'utf8');assert.ok(!disk.includes('vectors'));assert.ok(!disk.includes(String(first[0])));assert.equal(result.vectors,undefined);
  const reopened=new SpeakerLock(f.file,f.backend,f.crypto,()=>true);assert.equal(reopened.status().enrolled,true);
  f.setInstalled(false);assert.throws(()=>f.lock.configure({enabled:true,mode:'strict'}),/安装/);
  f.setInstalled(true);f.lock.configure({enabled:true,mode:'strict'});assert.equal(f.lock.status().enabled,true);
  assert.equal(f.lock.remove().enrolled,false);assert.equal(f.lock.status().enabled,false);assert.ok(!fs.existsSync(f.file));
});
test('inconsistent or short enrollment does not overwrite a usable old profile',async()=>{
  const f=fixture();await enroll(f);const before=fs.readFileSync(f.file,'utf8');let calls=0;
  f.backend.extract=async()=>({vectors:[++calls===2?other:first],voicedSeconds:6});await assert.rejects(f.lock.enroll(clips(),signal()),/不一致/);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  f.backend.extract=async()=>({vectors:[first],voicedSeconds:2});await assert.rejects(f.lock.enroll(clips(),signal()),/三秒/);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
});
test('all speech windows must match; short and failed audio never pass; disabled lock skips extraction',async()=>{
  const f=fixture();await enroll(f);assert.equal((await f.lock.check(clips()[0],signal())).allowed,true);
  f.backend.extract=async()=>({vectors:[first,other],voicedSeconds:6});assert.deepEqual((await f.lock.check(clips()[0],signal())).reason,'rejected');
  f.backend.extract=async()=>{throw new SpeakerAudioUncertain('short');};assert.equal((await f.lock.check(clips()[0],signal())).reason,'uncertain');
  f.backend.extract=async()=>{throw Error('engine failed');};await assert.rejects(f.lock.check(clips()[0],signal()),/engine failed/);
  f.lock.configure({enabled:false,mode:'standard'});assert.equal((await f.lock.check(clips()[0],signal())).allowed,true);
});
test('profile changes invalidate queued verification and in-flight enrollment',async()=>{
  const f=fixture();await enroll(f);const wait=deferred();f.backend.extract=async()=>{await wait.promise;return {vectors:[first],voicedSeconds:6};};
  const checking=f.lock.check(clips()[0],signal());f.lock.remove();wait.resolve();assert.equal((await checking).allowed,false);
  const second=deferred();f.backend.extract=async()=>{await second.promise;return {vectors:[first],voicedSeconds:6};};
  const enrolling=f.lock.enroll(clips(),signal());await assert.rejects(f.lock.enroll(clips(),signal()),/正在录入/);f.lock.remove();second.resolve();await assert.rejects(enrolling,/已变化/);assert.ok(!fs.existsSync(f.file));
});
test('cancelled enrollment and corrupt encrypted profiles fail closed but can be deleted',async()=>{
  const f=fixture(), controller=new AbortController();controller.abort();await assert.rejects(f.lock.enroll(clips(),controller.signal));assert.ok(!fs.existsSync(f.file));
  await enroll(f);fs.writeFileSync(f.file,JSON.stringify({enabled:true,mode:'strict',profile:'broken'}));await assert.rejects(f.lock.check(clips()[0],signal()));assert.throws(()=>f.lock.status());
  assert.equal(f.lock.remove().enabled,false);
});
test('host rejects a foreign speaker before cloud or system ASR; late profile changes discard the transcript',async()=>{
  const f=fixture();await enroll(f);let cloud=0,local=0;
  const response=deferred();const instance=new VoiceService(path.join(f.root,'voice.json'),{...f.crypto,speaker:f.lock,fetch:async()=>{cloud++;return response.promise;},local:{transcribe:async()=>{local++;return {text:'must not run'};}}});
  instance.save({...defaultVoiceSettings,recognitionEngine:'cloud',apiKey:'test-voice-key'});
  f.backend.extract=async()=>({vectors:[other],voicedSeconds:6});const input={id:'foreign',audio:clips()[0],mimeType:'audio/wav'};
  assert.deepEqual(await instance.transcribe(1,input),{text:'',speaker:'rejected'});assert.equal(cloud,0);
  instance.save({...instance.settings(),recognitionEngine:'system'});await instance.transcribe(1,{...input,id:'system'});assert.equal(local,0);
  instance.save({...instance.settings(),recognitionEngine:'cloud'});f.backend.extract=async()=>({vectors:[first],voicedSeconds:6});const active=instance.transcribe(1,{...input,id:'allowed'});
  while(!cloud) await new Promise(resolve=>setImmediate(resolve));f.lock.remove();response.resolve(Response.json({text:'late transcript'}));assert.deepEqual(await active,{text:'',speaker:'rejected'});
});

test('host supplies per-clip speaker proof only after a real enabled match',async()=>{
  const f=fixture(); await enroll(f);
  const service=new VoiceService(path.join(f.root,'voice.json'),{...f.crypto,speaker:f.lock,fetch:async()=>assert.fail('unexpected network'),local:{transcribe:async()=>({text:'本人说的话'})}});
  const input={id:'owner',audio:clips()[0],mimeType:'audio/wav'};
  f.backend.extract=async()=>({vectors:[first],voicedSeconds:6});
  assert.deepEqual(await service.transcribe(1,input),{text:'本人说的话',speakerVerified:true});
  f.lock.configure({enabled:false,mode:'strict'});
  assert.deepEqual(await service.transcribe(1,input),{text:'本人说的话'});
});
test('silence, short audio, clipping and invalid rates are uncertain or invalid, never accepted embeddings',()=>{
  const wav=(seconds,value=.05)=>{const bytes=Buffer.alloc(44+Math.round(seconds*32000));bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);for(let i=44;i<bytes.length;i+=2)bytes.writeInt16LE(Math.round(value*32767),i);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);};
  assert.throws(()=>speakerAudioWindows(wav(4,0)),SpeakerAudioUncertain);assert.throws(()=>speakerAudioWindows(wav(.8)),SpeakerAudioUncertain);assert.throws(()=>speakerAudioWindows(wav(4,1)),SpeakerAudioUncertain);
  const valid=speakerAudioWindows(wav(9));assert.ok(valid.windows.length>1);assert.ok(valid.windows.every(w=>w.length<=128000));
  const bad=wav(4);new DataView(bad).setUint32(24,48000,true);assert.throws(()=>speakerAudioWindows(bad));
  assert.throws(()=>normalizeSpeakerVector(Array(32).fill(0)));assert.throws(()=>normalizeSpeakerVector(Array(32).fill(NaN)));
});

test('named profiles persist independent samples and only the selected person is accepted',async()=>{
  const f=fixture();const owner=f.lock.saveProfile({name:'Owner'}).profiles[0].id;
  for(const audio of clips()) await f.lock.saveSample({profileId:owner,prompt:'Owner reading text',audio},signal());
  f.lock.configure({enabled:true,mode:'strict'});
  const guest=f.lock.saveProfile({name:'Guest'}).profiles.at(-1).id;
  f.backend.extract=async()=>({vectors:[other],voicedSeconds:6});
  for(const audio of clips()) await f.lock.saveSample({profileId:guest,prompt:'Guest reading text',audio},signal());
  assert.equal(f.lock.status().activeProfileId,owner,'adding a person does not switch authorization');
  assert.equal((await f.lock.check(clips()[0],signal())).allowed,false,'enrolled but unselected voices are rejected');
  f.lock.selectProfile(guest);assert.equal((await f.lock.check(clips()[0],signal())).allowed,true);
  f.backend.extract=async()=>({vectors:[first],voicedSeconds:6});assert.equal((await f.lock.check(clips()[0],signal())).allowed,false);
  const disk=fs.readFileSync(f.file,'utf8');assert.ok(!disk.includes('Guest'));assert.ok(!disk.includes('reading text'));assert.ok(!disk.includes('vector'));
  assert.ok(f.lock.status().profiles.every(profile=>profile.samples.every(sample=>sample.vector===undefined && sample.audio===undefined)));
  f.lock.saveProfile({profileId:guest,name:'Renamed'});assert.equal(f.lock.status().profiles[1].name,'Renamed');
  f.lock.remove(owner);assert.equal(f.lock.status().enabled,true);assert.equal(f.lock.status().profiles.length,1);
  f.lock.remove(guest);assert.equal(f.lock.status().enabled,false);assert.equal(f.lock.status().activeProfileId,undefined);
});

test('sample management preserves successful clips, blocks incomplete active profiles and discards late writes',async()=>{
  const f=fixture();const id=f.lock.saveProfile({name:'Owner'}).profiles[0].id;
  await f.lock.saveSample({profileId:id,prompt:'One',audio:clips()[0]},signal());
  assert.throws(()=>f.lock.configure({enabled:true,mode:'strict'}),/三段/);
  const old=f.lock.status().profiles[0].samples[0], before=fs.readFileSync(f.file,'utf8');
  f.backend.extract=async()=>({vectors:[first],voicedSeconds:2});
  await assert.rejects(f.lock.saveSample({profileId:id,sampleId:old.id,prompt:'Replacement',audio:clips()[1]},signal()),/三秒/);assert.equal(fs.readFileSync(f.file,'utf8'),before);
  f.backend.extract=async()=>({vectors:[first],voicedSeconds:6});
  for(const audio of clips().slice(1)) await f.lock.saveSample({profileId:id,prompt:'Another',audio},signal());
  await assert.rejects(f.lock.saveSample({profileId:id,prompt:'Duplicate',audio:clips()[0]},signal()),/已保存/);
  f.lock.configure({enabled:true,mode:'strict'});assert.throws(()=>f.lock.removeSample({profileId:id,sampleId:old.id}),/关闭锁定/);
  f.lock.configure({enabled:false,mode:'strict'});f.lock.removeSample({profileId:id,sampleId:old.id});assert.equal(f.lock.status().profiles[0].samples.length,2);
  const wait=deferred();f.backend.extract=async()=>{await wait.promise;return {vectors:[first],voicedSeconds:6};};
  const pending=f.lock.saveSample({profileId:id,prompt:'Late',audio:clips()[0]},signal());f.lock.remove(id);wait.resolve();await assert.rejects(pending,/已变化/);assert.equal(f.lock.status().profiles.length,0);
});

test('legacy encrypted single-person voice profiles remain usable and migrate on edit',async()=>{
  const f=fixture();const date='2026-01-01T00:00:00.000Z';
  fs.writeFileSync(f.file,JSON.stringify({enabled:true,mode:'strict',profile:f.crypto.encrypt(JSON.stringify({model:speakerDefinition().version,enrolledAt:date,vectors:[first,first,first]}))}));
  const before=fs.readFileSync(f.file,'utf8'),status=f.lock.status();assert.equal(status.activeProfileId,'legacy-profile');assert.equal(status.enrolled,true);assert.equal(status.profiles[0].samples.length,3);
  assert.equal(fs.readFileSync(f.file,'utf8'),before,'reading does not rewrite old enrollment');assert.equal((await f.lock.check(clips()[0],signal())).allowed,true);
  f.lock.saveProfile({profileId:'legacy-profile',name:'Owner'});const saved=JSON.parse(fs.readFileSync(f.file,'utf8'));
  assert.equal(JSON.parse(f.crypto.decrypt(saved.profile)).version,2);assert.equal(f.lock.status().enabled,true);
});
