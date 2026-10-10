import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { fileSize, fitImageSize, prepareAttachment, readImageInfo, uploadInChunks, uploadLimits } from '../web/attachmentUpload.ts';

const signal = () => new AbortController().signal;
const source = (width = 40, height = 30) => sharp({ create: { width, height, channels: 4, background: '#ffeedd80' } });
const imageFile = async (format = 'png') => new File([await source()[format]().toBuffer()], `sample.${format}`, { type: `image/${format}` });

test('reads actual PNG, JPEG and both WebP layouts instead of trusting the filename', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const file = await imageFile(format), info = await readImageInfo(file, signal());
    assert.deepEqual(info, { width: 40, height: 30, mime: `image/${format}` });
  }
  const lossless = await source().webp({ lossless: true }).toBuffer();
  assert.deepEqual(await readImageInfo(new Blob([lossless]), signal()), { width: 40, height: 30, mime: 'image/webp' });
  const jpeg = await source().jpeg({ progressive: true }).toBuffer();
  assert.equal((await readImageInfo(new Blob([jpeg]), signal())).width, 40);
});

test('small images keep their bytes and clipboard images receive a valid name and MIME', async () => {
  const file = await imageFile(), prepared = await prepareAttachment(file, signal(), () => {});
  assert.equal(prepared.file, file); assert.equal(prepared.note, undefined);
  const pasted = await prepareAttachment(new File([file], '', { type: 'image/png' }), signal(), () => {});
  assert.equal(pasted.file.name, '粘贴图片.png');
  assert.deepEqual(await pasted.file.arrayBuffer(), await file.arrayBuffer());
  const wrongExtension = await prepareAttachment(new File([file], 'clipboard.jpg', { type: 'image/jpeg' }), signal(), () => {});
  assert.equal(wrongExtension.file.name, 'clipboard.png'); assert.equal(wrongExtension.file.type, 'image/png');
});

test('large dimensions fit within the NAS pixel ceiling without stretching or enlarging', () => {
  for (const [width, height] of [[6000,4000], [4000,6000], [1000,60000], [60000,1000], [40,30]]) {
    const size = fitImageSize(width, height);
    assert.ok(size.width * size.height <= uploadLimits.imagePixels);
    assert.ok(Math.max(size.width, size.height) <= uploadLimits.imageEdge);
    assert.ok(size.width <= width && size.height <= height);
    assert.ok(Math.abs(size.width / size.height - width / height) <= 1 / size.height + width / height / size.height);
  }
  assert.deepEqual(fitImageSize(40, 30), { width: 40, height: 30 });
});

test('animated PNG and WebP cannot become accepted stills through canvas conversion', async () => {
  const png = Buffer.from(await (await imageFile()).arrayBuffer());
  const control = Buffer.alloc(20); control.writeUInt32BE(8); control.write('acTL', 4); control.writeUInt32BE(2, 8);
  await assert.rejects(prepareAttachment(new File([png.subarray(0,33), control, png.subarray(33)], 'animation.png'), signal(), () => {}), /动图/);
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22,4); webp.write('WEBPVP8X',8); webp.writeUInt32LE(10,16); webp[20]=2;
  await assert.rejects(prepareAttachment(new File([webp], 'animation.webp'), signal(), () => {}), /动图/);
});

test('documents retain their limit while large image input is bounded before reading or decoding', async () => {
  const notRead = { arrayBuffer() { assert.fail('oversize source must not be read'); } };
  await assert.rejects(prepareAttachment({ ...notRead, name: 'photo.png', type: 'image/png', size: uploadLimits.sourceImageBytes + 1 }, signal(), () => {}), /超过 64 MB/);
  await assert.rejects(prepareAttachment({ ...notRead, name: 'report.pdf', type: 'application/pdf', size: uploadLimits.fileBytes + 1 }, signal(), () => {}), /文档最大支持 16 MB/);
  await assert.rejects(prepareAttachment(new File([], 'empty.png'), signal(), () => {}), /附件为空/);
  const bytes = Buffer.from(await (await imageFile()).arrayBuffer()); bytes.writeUInt32BE(100000, 16); bytes.writeUInt32BE(100000, 20);
  await assert.rejects(readImageInfo(new Blob([bytes]), signal()), /6400 万像素/);
});

test('video, forged formats, corrupt chunk lengths and unsupported image formats fail locally', async () => {
  for (const name of ['video.mp4', 'video.png', 'video.txt']) {
    await assert.rejects(prepareAttachment(new File(['0000ftypmp42VIDEO'], name, { type: 'video/mp4' }), signal(), () => {}), /不支持视频/);
  }
  await assert.rejects(prepareAttachment(new File(['0000ftypmp42VIDEO'], 'fake.png'), signal(), () => {}), /静态/);
  await assert.rejects(prepareAttachment(new File(['GIF89a'], 'animation.gif', { type: 'image/gif' }), signal(), () => {}), /静态/);
  const png = Buffer.from(await (await imageFile()).arrayBuffer()); png.writeUInt32BE(0xffffffff, 8);
  await assert.rejects(readImageInfo(new Blob([png]), signal()), /静态/);
});

test('chunks arrive in order and progress completes only after a validated final acknowledgement', async () => {
  const file = new File([Buffer.alloc(uploadLimits.chunkBytes + 20, 42)], 'sample.txt'), chunks = [], progress = [];
  const attachment = { id: 'mine', path: '/data/workspaces/uploads/mine/sample.txt' };
  const result = await uploadInChunks(file, signal(), async chunk => {
    chunks.push(chunk); return { nextOffset: chunk.offset + Buffer.from(chunk.content,'base64').length, ...(chunk.done ? { attachment } : {}) };
  }, value => progress.push(value));
  assert.equal(result, attachment); assert.deepEqual(chunks.map(chunk => chunk.offset), [0, uploadLimits.chunkBytes]);
  assert.deepEqual(chunks.map(chunk => chunk.done), [false,true]); assert.equal(progress.at(-1), 100);
  assert.ok(chunks.every(chunk => Buffer.from(chunk.content,'base64').every(value => value === 42)));
});

test('a lost network acknowledgement retries the identical chunk and cancellation fences later chunks', async () => {
  const file = new File(['hello'], 'sample.txt'), calls = [];
  await uploadInChunks(file, signal(), async chunk => { calls.push(chunk); if (calls.length===1) throw new TypeError('network'); return { nextOffset: 5, attachment: { id: 'mine' } }; }, () => {});
  assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
  const controller = new AbortController(); let count = 0;
  await assert.rejects(uploadInChunks(new File([Buffer.alloc(uploadLimits.chunkBytes + 1)], 'big.txt'), controller.signal, async chunk => {
    count++; controller.abort(); return { nextOffset: chunk.offset + Buffer.from(chunk.content,'base64').length };
  }, () => {}), { name: 'AbortError' });
  assert.equal(count, 1);
});

test('invalid acknowledgements and terminal errors cannot hang an upload or silently lose an attachment', async () => {
  const file = new File(['hello'], 'sample.txt');
  for (const nextOffset of [0, -1, 100, NaN]) await assert.rejects(uploadInChunks(file, signal(), async () => ({ nextOffset }), () => {}), /上传进度异常/);
  await assert.rejects(uploadInChunks(file, signal(), async () => ({ nextOffset: 5 }), () => {}), /附件未保存/);
  let count=0;
  await assert.rejects(uploadInChunks(file, signal(), async () => { count++; throw Object.assign(new Error('Unsupported'),{status:400}); }, () => {}), /Unsupported/);
  assert.equal(count, 1);
  const controller=new AbortController(); controller.abort();
  await assert.rejects(prepareAttachment(file, controller.signal, () => assert.fail('no preparation after logout')), { name:'AbortError' });
});

test('size feedback includes the real size rather than a generic unsupported-format message', () => {
  assert.equal(fileSize(20*1024*1024), '20.0 MB'); assert.equal(fileSize(2048), '2 KB');
});

test('lossy optimization bounds the NAS PNG copy and always releases bitmap and canvas memory', async t => {
  const previous = Object.fromEntries(['createImageBitmap','OffscreenCanvas','HTMLCanvasElement'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(() => { for (const [key,value] of Object.entries(previous)) { if (value) Object.defineProperty(globalThis,key,value); else delete globalThis[key]; } });
  let closed = 0, canvas; const encodes = [];
  globalThis.createImageBitmap = async () => ({ width:6000,height:4000,close() { closed++; } });
  globalThis.HTMLCanvasElement = class {};
  globalThis.OffscreenCanvas = class {
    constructor(width,height) { this.width=width;this.height=height;canvas=this; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob({ type }) { encodes.push({type,width:this.width,height:this.height}); return new Blob([Buffer.alloc(type==='image/png'?uploadLimits.targetImageBytes+1:100_000)],{type}); }
  };
  const bytes=await source(6000,4000).png().toBuffer(), file=new File([bytes],'large.png',{type:'image/png'});
  const prepared=await prepareAttachment(file,signal(),()=>{});
  assert.equal(prepared.file.type,'image/webp');assert.match(prepared.note,/已优化/);
  assert.ok(encodes.find(value=>value.type==='image/webp').width*encodes.find(value=>value.type==='image/webp').height<=uploadLimits.lossyImagePixels);
  assert.equal(closed,1);assert.equal(canvas.width,1);assert.equal(canvas.height,1);
  const controller=new AbortController();
  canvas=undefined;
  globalThis.createImageBitmap=async()=>{controller.abort();return {close(){closed++;}};};
  await assert.rejects(prepareAttachment(file,controller.signal,()=>{}),{name:'AbortError'});
  assert.equal(closed,2);assert.equal(canvas,undefined);
});
