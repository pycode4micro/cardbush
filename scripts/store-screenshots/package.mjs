import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import JSZip from 'jszip';

export async function packageScreenshots(output, version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const source = path.resolve(import.meta.dirname, '../../packaging/msix/listing');
  const template = await fs.readFile(path.join(import.meta.dirname, 'listing.html'), 'utf8');
  const zip = new JSZip();
  const records = [];
  const save = async (name, data) => {
    await fs.writeFile(path.join(output, name), data);
    zip.file(name, data);
  };
  for (const locale of ['zh-CN', 'en-US']) {
    const listing = await fs.readFile(path.join(source, locale, 'listing.md'), 'utf8');
    const entries = [...listing.matchAll(/^!\[([^\]\n]+)\]\((\d{2}-[a-z]+\.png)\)$/gm)];
    assert.equal(entries.length, 5, locale);
    assert.equal(new Set(entries.map(entry => entry[2])).size, entries.length);
    for (const [, caption, name] of entries) {
      const file = locale + '/' + name;
      const data = await fs.readFile(path.join(output, file));
      assert.ok(caption.length <= 200);
      assert.ok(data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')));
      assert.deepEqual([data.readUInt32BE(16),data.readUInt32BE(20)], [1920,1080]);
      assert.ok(data.length < 50 * 1024 * 1024);
      records.push({file,caption,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
      zip.file(file,data);
    }
    await save(locale+'/listing.md',listing);
    const body = renderToStaticMarkup(createElement(Markdown, null, listing));
    await save(locale+'/index.html',template.replace('{{locale}}',locale).replace('{{version}}',version).replace('{{content}}',() => body));
  }
  await save('captions.tsv', records.map(item => item.file+'\t'+item.caption).join('\n')+'\n');
  await save('SHA256SUMS.txt', records.map(item => item.sha256+'  '+item.file).join('\n')+'\n');
  await save('screenshots.json', JSON.stringify({version,resolution:'1920x1080',screenshots:records},null,2)+'\n');
  const archive = path.join(output, 'CardBush-'+version+'-store-listing.zip');
  const bytes = await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  await fs.writeFile(archive, bytes);
  const saved = await JSZip.loadAsync(await fs.readFile(archive), {checkCRC32:true});
  assert.equal(Object.keys(saved.files).filter(name=>name.endsWith('.png')).length,records.length);
  console.log(archive);
}
