const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const limit = 256 * 1024;
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
    snapshot, close: () => db.close(),
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
    publish: (source, home) => change(state => {
      const previous = state.items.find(item => item.id === source.id);
      const component = {...source, order: previous?.order ?? Math.max(-1,...state.items.map(item => item.order)) + 1,
        home: home ?? previous?.home ?? false, allowActions: false};
      return previous ? state.items.map(item => item.id === source.id ? component : item) : [...state.items, component];
    }),
  };
}
module.exports = { openLibrary };
