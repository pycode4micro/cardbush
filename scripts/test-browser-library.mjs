import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { BrowserBookmarkImporter, parseBrowserBookmarks } from '../dist-electron/browserImport.js';
import { BrowserLibrary } from '../dist-electron/browserLibrary.js';

async function fixture(t) {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'browser-library-'));
  t.after(async () => { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('Chrome JSON and Edge HTML import folders, Unicode and more than 100 URLs without executing content', () => {
  const links = Array.from({ length: 180 }, (_, i) => ({ type: 'url', name: `中文书签 ${i}`, url: `https://example.com/${i}` }));
  const json = parseBrowserBookmarks(JSON.stringify({ roots: { bookmark_bar: { name: '收藏夹栏', children: [...links, links[0], { type: 'url', url: 'javascript:alert(1)' }, { type: 'url', url: 'https://user:secret@example.com/' }] } } }));
  assert.equal(json.bookmarks.length, 180); assert.equal(json.skipped, 3); assert.equal(json.bookmarks[179].folder, '收藏夹栏');
  const html = parseBrowserBookmarks('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>目录 &amp; 子项</H3><DL><DT><A HREF="https://example.com/?a=1&amp;b=2">&#x4e2d;&#25991; &lt;名称&gt;</A><DT><A HREF="data:text/html,script">Unsafe</A></DL><DT><A HREF="https://second.example/">outside</A></DL><script>throw Error("never executes")</script>');
  assert.equal(html.bookmarks[0].title, '中文 <名称>'); assert.equal(html.bookmarks[0].url, 'https://example.com/?a=1&b=2');
  assert.equal(html.bookmarks[0].folder, '目录 & 子项'); assert.equal(html.bookmarks[1].folder, undefined); assert.equal(html.skipped, 1);
  assert.throws(() => parseBrowserBookmarks('{"name":"not bookmarks"}'));
});

test('profile discovery stays within known Chrome and Edge profiles and supports exported files', async t => {
  const root = await fixture(t), roots = { chrome: join(root, 'chrome'), edge: join(root, 'edge') };
  for (const [browser, directory] of Object.entries(roots)) {
    await mkdir(join(directory, 'Default'), { recursive: true });
    await writeFile(join(directory, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: `${browser} work` } } } }));
    await writeFile(join(directory, 'Default', 'Bookmarks'), JSON.stringify({ roots: { other: { name: 'Other', children: [{ type: 'url', name: 'Site', url: 'https://example.com' }] } } }));
  }
  const importer = new BrowserBookmarkImporter(roots), profiles = await importer.profiles();
  assert.equal(profiles.length, 2); assert.equal(profiles[0].name, 'chrome work');
  assert.equal((await importer.profile('edge:Default')).bookmarks.length, 1);
  await assert.rejects(importer.profile('chrome:../../outside'));
  assert.deepEqual((await new BrowserBookmarkImporter({ chrome: join(root, 'missing'), edge: join(root, 'missing2') }).profiles()), []);
});

test('history and downloads serialize concurrent writes, page results and keep files when clearing', async t => {
  const root = await fixture(t), file = join(root, 'records.json'), library = new BrowserLibrary(file);
  await Promise.all(Array.from({ length: 65 }, (_, i) => library.visit(`https://example.com/${i}`, `Visit ${i}`)));
  const first = await library.list('history'); assert.equal(first.items.length, 50); assert.equal(first.total, 65); assert.equal(first.nextOffset, 50);
  const second = await library.list('history', '', first.nextOffset); assert.equal(second.items.length, 15); assert.equal(second.nextOffset, undefined);
  await library.visit('https://example.com/1', 'Updated title', false);
  assert.equal((await library.list('history', 'Updated title')).items[0].visits, 1);
  await library.visit('https://user:secret@example.com', 'Unsafe');
  assert.equal((await library.list('history')).total, 65);
  const downloadPath = join(root, 'download.txt'); await writeFile(downloadPath, 'keep this file');
  const download = { id: 'download', url: 'https://example.com/file', path: downloadPath, name: 'download.txt', received: 4, total: 10, state: 'progressing', paused: false, startedAt: Date.now() };
  await library.download(download);
  assert.equal((await new BrowserLibrary(file).list('downloads')).items[0].state, 'interrupted', 'restart never claims a download is still running');
  await library.clear(true, true);
  assert.equal((await library.list('history')).total, 0); assert.equal((await library.list('downloads')).total, 1, 'active downloads survive clearing');
  await library.download({ ...download, state: 'completed' }); await library.clear(false, true);
  assert.equal((await library.list('downloads')).total, 0); assert.equal(await readFile(downloadPath, 'utf8'), 'keep this file');
  assert.equal((await new BrowserLibrary(file).list('history')).total, 0);
});

test('frequent sites rank all retained visits by site, persist and follow history changes', async t => {
  const root = await fixture(t), file = join(root, 'records.json');
  const history = Array.from({ length: 65 }, (_, i) => ({ id: `recent-${i}`, url: `https://recent-${i}.example/page`, title: 'Recent page', visitedAt: 1000 - i, visits: 1 }));
  history.push(
    { id: 'work-a', url: 'https://work.example/report?private=query', title: 'Report', visitedAt: 20, visits: 4 },
    { id: 'work-b', url: 'https://work.example/draft#section', title: 'Draft', visitedAt: 30, visits: 3 },
    { id: 'second', url: 'https://second.example/page', title: 'Page', visitedAt: 10, visits: 5 },
  );
  await writeFile(file, JSON.stringify({ history, downloads: [] }));
  let notifications = 0;
  const library = new BrowserLibrary(file, () => notifications++);
  const sites = await library.frequentSites();
  assert.equal(sites.length, 8);
  assert.deepEqual(sites[0], { url: 'https://work.example/', title: 'work.example', visits: 7, visitedAt: 30 }, 'older frequent visits beyond the first history page still rank first, without sensitive paths or duplicate origins');
  assert.equal(sites[1].url, 'https://second.example/');
  assert.equal(sites[2].url, 'https://recent-0.example/', 'equally visited sites use recency');
  await library.visit('https://work.example/report?private=query', 'Updated title', false);
  assert.equal((await library.frequentSites())[0].visits, 7, 'title changes do not inflate frequency');
  assert.equal(notifications, 1);
  const pending = library.visit('https://work.example/new', 'New page');
  assert.equal((await library.frequentSites())[0].visits, 8, 'reads include pending visits');
  await pending;
  assert.deepEqual(await new BrowserLibrary(file).frequentSites(), await library.frequentSites(), 'ranking survives restarting');
  await library.removeVisit('work-a');
  assert.equal((await library.frequentSites())[0].url, 'https://second.example/', 'deleting history changes ranking');
  assert.equal(notifications, 3);
  await library.clear(false, true);
  assert.equal(notifications, 3, 'download changes do not invalidate site history');
  await library.clear(true, false);
  assert.deepEqual(await library.frequentSites(), []);
  assert.deepEqual(await new BrowserLibrary(file).frequentSites(), []);
  assert.equal(notifications, 4);
});
