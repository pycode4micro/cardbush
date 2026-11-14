const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { componentOrigins, componentOrigin, approvedWebsiteUrl } = require('./component-origins.mjs');

const limit = 256 * 1024;
function requestedOrigins(value) {
  if (!Array.isArray(value) || value.length > 8 || value.some(origin => !componentOrigin(origin))) throw Error('INVALID_COMPONENT_ORIGIN');
  return componentOrigins(value);
}
function validate(items, capacity) {
  if (!Array.isArray(items) || items.length > capacity) throw Error('COMPONENT_LIMIT');
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(item.id) || item.id.startsWith('system-') || seen.has(item.id) ||
      typeof item.title !== 'string' || !item.title.trim() || item.title.length > 80 ||
      typeof item.html !== 'string' || Buffer.byteLength(item.html) > limit ||
      !Number.isInteger(item.width) || item.width < 3 || item.width > 12 ||
      !Number.isInteger(item.height) || item.height < 120 || item.height > 1200 || !Number.isFinite(item.order) ||
      typeof item.allowActions !== 'boolean' || (item.home !== undefined && typeof item.home !== 'boolean')) throw Error('INVALID_COMPONENT');
    seen.add(item.id);
    if (item.homeWebsiteUrl != null && !approvedWebsiteUrl(item.homeWebsiteUrl, componentOrigins(item.embedDomains))) throw Error('INVALID_COMPONENT_WEBSITE');
  }
}
function openLibrary(profile) {
  mkdirSync(profile, {recursive: true});
  const db = new DatabaseSync(join(profile, 'home-components.sqlite'));
  db.exec("PRAGMA busy_timeout=4000; CREATE TABLE IF NOT EXISTS library(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, items TEXT NOT NULL, migrated INTEGER NOT NULL); INSERT OR IGNORE INTO library VALUES(1,0,'[]',0)");
  function snapshot(known) {
    const row = db.prepare('SELECT revision,items FROM library WHERE id=1 AND revision != ?').get(known ?? -1);
    return row ? { version: 1, revision: row.revision, items: JSON.parse(row.items) } : null;
  }
  function change(edit, migrating = false) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = snapshot();
      const items = edit(state);
      if (items) {
        validate(items, migrating ? 24 : Math.max(12,state.items.length));
        db.prepare('UPDATE library SET items=?, revision=revision+1 WHERE id=1').run(JSON.stringify(items));
      }
      const result = snapshot();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {
    snapshot, describe: componentInfo, close: () => db.close(),
    save: (items, revision) => change(state => {
      if (revision !== state.revision) throw Error('REVISION_CONFLICT');
      return items;
    }),
    migrate: items => change(state => {
      if (db.prepare('SELECT migrated FROM library WHERE id=1').get().migrated) return;
      const additions = items.filter(old => !state.items.some(item => item.id === old.id));
      db.exec('UPDATE library SET migrated=1 WHERE id=1');
      if (additions.length) return [...state.items, ...additions];
    }, true),
    publish: (source, home, expectedRevision) => change(state => {
      if (expectedRevision !== undefined && state.revision !== expectedRevision) throw Error('REVISION_CONFLICT');
      const previous = state.items.find(item => item.id === source.id);
      const sameCode = previous && previous.html === source.html;
      const networkDomains = requestedOrigins(source.networkDomains ?? previous?.networkDomains ?? []);
      const embedDomains = requestedOrigins(source.embedDomains ?? previous?.embedDomains ?? []);
      const approvedEmbedOrigins = embedDomains;
      const component = {id:source.id, html:source.html, title:source.title ?? previous?.title, width:source.width ?? previous?.width ?? 6,
        height:source.height ?? previous?.height ?? 280, order: previous?.order ?? Math.max(-1,...state.items.map(item => item.order)) + 1,
        home: home ?? previous?.home ?? false, allowActions: Boolean(sameCode && previous.allowActions),
        embedDomains, approvedEmbedOrigins,
        homeWebsiteUrl: sameCode ? previous.homeWebsiteUrl === null ? null : approvedWebsiteUrl(previous.homeWebsiteUrl, embedDomains) : undefined,
        networkDomains, approvedNetworkOrigins: sameCode ? componentOrigins(previous.approvedNetworkOrigins).filter(origin => networkDomains.includes(origin)) : []};
      return previous ? state.items.map(item => item.id === source.id ? component : item) : [...state.items, component];
    }),
  };
}
function componentInfo(item) {
  const {id,title,home,width,height,order,allowActions,html} = item;
  const networkDomains = componentOrigins(item.networkDomains);
  const embedDomains = componentOrigins(item.embedDomains);
  return {id,title,home,width,height,order,allowActions,networkDomains,embedDomains,
    approvedEmbedOrigins: embedDomains,
    approvedNetworkOrigins: componentOrigins(item.approvedNetworkOrigins).filter(origin => networkDomains.includes(origin)),
    length: html.length, bytes: Buffer.byteLength(html), sha256:createHash('sha256').update(html).digest('hex')};
}
module.exports = { openLibrary, componentInfo };
