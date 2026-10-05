import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

async function load(path) {
  const result = await build({ configFile:false, logLevel:'silent', build:{ write:false, minify:false, lib:{ entry:path, formats:['es'] } } });
  const output = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk').code;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}
const shared = await load('src/shared/chatAttachments.ts');
const remote = await load('src/features/assistant/assistantAttachments.ts');

test('shared attachment parsing preserves spaces, image settings and file metadata without leaking paths into bubble text', async () => {
  const original = globalThis.window;
  globalThis.window = { cardbushDesktop:{ inspectAttachments:async paths => paths.map(path => ({ path, kind:'file', size:12 })) } };
  try {
    const value = shared.splitStreamAttachmentMentions('@C:/My Files/笔记.txt\n@C:/My Files/image.png\n帮我看看');
    assert.equal(value.displayInput, '帮我看看');
    assert.deepEqual(value.files, ['C:/My Files/笔记.txt']);
    assert.deepEqual(shared.streamAttachmentsForVision(value, false).images, []);
    assert.deepEqual(shared.streamAttachmentsForVision(value, false).files, ['C:/My Files/笔记.txt', 'C:/My Files/image.png']);
    const files = await shared.chatAttachmentsFromOutbound(value);
    assert.equal(files.find(item => item.type === 'document').size, 12);
    assert.equal(files[0].type, 'image');
  } finally { globalThis.window = original; }
});

test('assistant cloud attachments use chunk uploads and retain local originals; failures and unsupported folders reject sending', async () => {
  const originals = { window:globalThis.window, fetch:globalThis.fetch, localStorage:globalThis.localStorage };
  const calls = [], storage = new Map(); let existing = false, fail = false;
  globalThis.localStorage = { getItem:key => storage.get(key), setItem:(key,value) => storage.set(key,value) };
  globalThis.fetch = async () => new Response(new Blob(['hello']));
  globalThis.window = { cardbushDesktop:{ agents:{ connect:async id => { calls.push(['connect',id]); }, call:async (id, op, input) => {
    calls.push([op,id,input]);
    if(op==='sessions.get')return existing ? { sessionId:input.sessionId } : null;
    if(op==='sessions.create'){existing=true;return {};}
    if(op==='files.upload'){if(fail)throw Error('upload failed');return {path:'/remote/attachments/note.txt',nextOffset:input.offset+Buffer.from(input.content,'base64').length};}
    throw Error('unexpected operation');
  } } } };
  const file = {id:'file',name:'note.txt',type:'document',path:'C:/Notes/note.txt',size:5};
  try {
    assert.deepEqual(await remote.assistantExecutionAttachments([file], ''), [file]);
    assert.equal(calls.length, 0);
    const output = await remote.assistantExecutionAttachments([file], 'ssh-1');
    assert.equal(output[0].path, file.path);
    assert.deepEqual(output[0].execution, {connectionId:'ssh-1',path:'/remote/attachments/note.txt'});
    assert.equal(calls.find(([op])=>op==='files.upload')[2].complete, true);
    fail=true; await assert.rejects(remote.assistantExecutionAttachments([file], 'ssh-1'), /upload failed/);
    assert.equal(calls.filter(([op])=>op==='sessions.create').length, 1, 'reuse the attachment workspace');
    await assert.rejects(remote.assistantExecutionAttachments([{...file,type:'folder'}], 'ssh-1'), /ZIP/);
    await assert.rejects(remote.assistantExecutionAttachments([{...file,size:65*1024*1024}], 'ssh-1'), /64 MiB/);
  } finally { Object.assign(globalThis, originals); }
});
