'use strict';
const $ = id => document.getElementById(id);
const catalogs = JSON.parse($('catalogs').textContent);
const web = document.documentElement.dataset.host === 'web';
const pending = new Map();
let serial = 0, language = 'en', state = null, draft = null, selected = null, busy = false;
let patches = new Map(), drag = null;
const textFields = ['text', 'font_size', 'color', 'bold', 'italic', 'font_path'];
function t(key, values = {}) {
  const message = catalogs[language]?.[key] ?? catalogs.en[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
}
function localize(context = {}) {
  const requested = String(context.locale || context.language || language).toLowerCase();
  language = Object.keys(catalogs).find(key => requested === key.toLowerCase() || requested.startsWith(key.toLowerCase() + '-')) || 'en';
  document.documentElement.lang = language;
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  for (const [name, value] of Object.entries(context.styles?.variables || {})) {
    if (/^--[a-z0-9-]+$/.test(name) && typeof value === 'string') document.documentElement.style.setProperty(name, value);
  }
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
  if (draft) paint();
}
function notify(method, params) { parent.postMessage({jsonrpc: '2.0', method, params}, '*'); }
function rpc(method, params) {
  const id = 'seedream-layers-' + (++serial);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(t('timeout'))); }, 60000);
    pending.set(id, {resolve, reject, timer});
    parent.postMessage({jsonrpc: '2.0', id, method, params}, '*');
  });
}
async function tool(name, args) {
  const result = await rpc('tools/call', {name, arguments: args});
  if (result?.isError) throw new Error(t('error.' + (result.structuredContent?.error?.code || 'unknown')));
  return result;
}
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function current() { return draft?.layers.find(layer => layer.id === selected); }
function latest() { return Math.max(...(state?.history || []).map(item => item.revision), draft?.revision || 0); }
function controls() {
  const historical = draft && draft.revision < latest();
  for (const element of document.querySelectorAll('button,input,textarea,select')) element.disabled = busy;
  $('save').disabled = busy || historical || !patches.size;
  $('discard').disabled = busy || !patches.size;
  $('history').disabled = busy || Boolean(patches.size);
  $('export').disabled = busy || Boolean(patches.size);
  $('export-layer').disabled = busy || Boolean(patches.size);
  $('restore').hidden = !historical;
  $('dirty').hidden = !patches.size;
  for (const element of document.querySelectorAll('.inspector input,.inspector textarea,.inspector button,.layer-row input')) element.disabled = busy || historical;
  if (!current()?.text) for (const id of textFields.filter(id => id !== 'text')) $(id).disabled = true;
}
async function work(fn) {
  if (busy) return;
  busy = true; controls(); status(t('working'));
  try { await fn(); } catch (error) { status(error.message || t('error.unknown'), true); }
  finally { busy = false; controls(); resize(); }
}
function resize() { notify('ui/notifications/size-changed', {height: Math.min(900, Math.ceil(document.body.scrollHeight))}); }
function accept(result, keepDraft = false) {
  const panel = result?._meta?.seedream_layers;
  if (!panel?.document) return false;
  if (state && state.document.id !== panel.document.id) return false;
  const retained = keepDraft ? patches : new Map();
  state = panel; draft = structuredClone(panel.document); patches = retained;
  for (const [id, patch] of patches) {
    const layer = draft.layers.find(item => item.id === id);
    if (layer) Object.assign(layer, structuredClone(patch));
  }
  if (!draft.layers.some(layer => layer.id === selected)) selected = draft.layers.at(-1)?.id;
  $('waiting').hidden = true; $('workspace').hidden = false;
  paint(); resize(); return true;
}
function patch(values) {
  if (busy || !current() || draft.revision < latest()) return;
  Object.assign(current(), values);
  patches.set(selected, {...patches.get(selected), ...structuredClone(values)});
  scene(); controls();
}
function scene() {
  $('stage').style.aspectRatio = `${draft.width} / ${draft.height}`;
  const children = [];
  for (const layer of [...draft.layers].sort((a, b) => a.z_index - b.z_index)) {
    const element = document.createElement('div');
    element.className = 'canvas-layer'; element.dataset.layer = layer.id;
    element.setAttribute('aria-selected', String(layer.id === selected));
    element.setAttribute('aria-label', layer.name); element.hidden = !layer.visible;
    Object.assign(element.style, {left: `${layer.x / draft.width * 100}%`, top: `${layer.y / draft.height * 100}%`,
      width: `${layer.width / draft.width * 100}%`, height: `${layer.height / draft.height * 100}%`, opacity: String(layer.opacity)});
    if (patches.get(layer.id)?.text) {
      const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${layer.width} ${layer.height}`);
      const text = document.createElementNS(ns, 'text'), style = layer.text;
      text.setAttribute('font-size', style.font_size); text.setAttribute('fill', style.color);
      text.setAttribute('font-family', 'Microsoft YaHei, Noto Sans CJK SC, sans-serif');
      text.setAttribute('font-weight', style.bold ? 'bold' : 'normal');
      text.setAttribute('font-style', style.italic ? 'italic' : 'normal');
      style.content.split('\n').forEach((line, index) => {
        const span = document.createElementNS(ns, 'tspan'); span.setAttribute('x', '0'); span.setAttribute('y', String(style.font_size * (.85 + index * 1.2))); span.textContent = line; text.append(span);
      });
      svg.append(text); element.append(svg);
    } else {
      const image = document.createElement('img'); image.src = patches.get(layer.id)?.text === null && state.original_thumbnails?.[layer.id] || state.thumbnails[layer.id]; image.alt = ''; image.draggable = false; element.append(image);
    }
    children.push(element);
  }
  $('stage').replaceChildren(...children);
}
function inspector() {
  const layer = current(); if (!layer) return;
  for (const field of ['name', 'x', 'y', 'width', 'height', 'opacity']) $(field).value = layer[field];
  $('visible').checked = layer.visible;
  if (!web) $('replacement_path').value = patches.get(layer.id)?.replacement_path || '';
  const style = layer.text;
  $('text').value = style?.content ?? '';
  $('font_size').value = style?.font_size ?? Math.max(1, Math.round(layer.height * .8));
  $('color').value = style?.color ?? '#202020';
  $('bold').checked = Boolean(style?.bold); $('italic').checked = Boolean(style?.italic);
  $('font_path').value = style?.font_path ?? '';
  controls();
}
function layerList() {
  const rows = [...draft.layers].sort((a, b) => b.z_index - a.z_index).map(layer => {
    const row = document.createElement('div'); row.className = 'layer-row'; row.setAttribute('role', 'listitem');
    const button = document.createElement('button'); button.className = 'layer-select'; button.setAttribute('aria-pressed', String(layer.id === selected)); button.dataset.layer = layer.id;
    const image = document.createElement('img'); image.src = state.thumbnails[layer.id]; image.alt = '';
    const name = document.createElement('span'); name.textContent = layer.name;
    button.append(image, name); button.addEventListener('click', () => { selected = layer.id; paint(); });
    const visible = document.createElement('input'); visible.type = 'checkbox'; visible.checked = layer.visible;
    visible.setAttribute('aria-label', t('visibility', {name: layer.name}));
    visible.addEventListener('change', () => { selected = layer.id; patch({visible: visible.checked}); inspector(); });
    row.append(button, visible); return row;
  });
  $('layer-list').replaceChildren(...rows);
}
function paint() {
  $('title').textContent = draft.title;
  $('revision').textContent = t('version', {revision: draft.revision});
  $('dimensions').textContent = `${new Intl.NumberFormat(language).format(draft.width)} × ${new Intl.NumberFormat(language).format(draft.height)}`;
  $('history').replaceChildren(...state.history.map(item => new Option(t('version', {revision: item.revision}), String(item.revision), false, item.revision === draft.revision)));
  layerList(); scene(); inspector();
}
for (const field of ['name', 'x', 'y', 'width', 'height', 'opacity', ...(web ? [] : ['replacement_path'])]) $(field).addEventListener('input', () => {
  if (!$(field).checkValidity()) return;
  patch({[field]: ['name', 'replacement_path'].includes(field) ? $(field).value : Number($(field).value)});
  if (field === 'name') layerList();
});
$('visible').addEventListener('change', () => { patch({visible: $('visible').checked}); layerList(); controls(); });
function textPatch() {
  if (!$('font_size').checkValidity()) return;
  patch({text: {content: $('text').value, font_size: Number($('font_size').value), color: $('color').value,
    bold: $('bold').checked, italic: $('italic').checked, font_path: $('font_path').value || null}});
}
for (const id of textFields) $(id).addEventListener('input', textPatch);
$('use-ocr').addEventListener('click', () => {
  const recognition = current()?.metadata?.text_recognition, lines = recognition?.lines || [];
  const text = recognition?.text || lines.map(line => line.text ?? (line.runs || []).map(run => run.text).join('')).join('\n');
  if (!text) { status(t('noOcr'), true); return; }
  const style = lines[0]?.runs?.[0]?.style || {};
  $('text').value = text; $('font_size').value = Math.max(1, Math.round(current().height / Math.max(1, text.split('\n').length) * .8));
  $('color').value = /^#[a-f0-9]{6}$/i.test(style.foreground_color) ? style.foreground_color : '#202020';
  $('bold').checked = Boolean(style.bold); $('italic').checked = Boolean(style.italic);
  textPatch(); inspector();
});
$('raster').addEventListener('click', () => { patch({text: null}); inspector(); });
function reorder(direction) {
  const ordered = [...draft.layers].sort((a, b) => a.z_index - b.z_index);
  const index = ordered.findIndex(item => item.id === selected), target = index + direction;
  if (target < 0 || target >= ordered.length) return;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [z_index, layer] of ordered.entries()) {
    if (layer.z_index !== z_index) { layer.z_index = z_index; patches.set(layer.id, {...patches.get(layer.id), z_index}); }
  }
  paint();
}
$('raise').addEventListener('click', () => reorder(1)); $('lower').addEventListener('click', () => reorder(-1));
$('save').addEventListener('click', () => work(async () => {
  const changes = [...patches].map(([id, values]) => ({id, ...values}));
  const result = await tool('seedream_layer_edit', {project_id: draft.id, expected_revision: draft.revision, changes});
  accept(result); status(t('saved', {revision: draft.revision}));
}));
$('discard').addEventListener('click', () => { patches.clear(); draft = structuredClone(state.document); paint(); status(t('ready', {count: draft.layers.length})); });
$('refresh').addEventListener('click', () => work(async () => {
  const hadDraft = Boolean(patches.size);
  accept(await tool('seedream_layer_project', {action: 'open', project_id: draft.id}), true);
  status(hadDraft ? t('draftKept') : t('ready', {count: draft.layers.length}));
}));
$('history').addEventListener('change', () => work(async () => {
  accept(await tool('seedream_layer_project', {action: 'open', project_id: draft.id, revision: Number($('history').value)}));
  status(t('version', {revision: draft.revision}));
}));
$('restore').addEventListener('click', () => work(async () => {
  accept(await tool('seedream_layer_project', {action: 'restore', project_id: draft.id, expected_revision: latest(), source_revision: draft.revision}));
  status(t('saved', {revision: draft.revision}));
}));
async function exportFile(layer_id) {
  if (patches.size) { status(t('dirtyBlocked'), true); return; }
  await work(async () => {
    const format = layer_id ? 'png' : $('format').value;
    const result = await tool('seedream_layer_export', {project_id: draft.id, revision: draft.revision, format, ...(layer_id ? {layer_id} : {})});
    const row = document.createElement('div'); row.className = 'download-row'; row.setAttribute('role', 'listitem');
    const label = document.createElement('span'); label.textContent = t('exported', {format: format.toUpperCase()});
    const path = result.structuredContent.path;
    let control;
    if (web) {
      control = document.createElement('button');
      control.textContent = t('downloadWeb');
      control.addEventListener('click', () => work(() => rpc('seedream/download', {path})));
      await rpc('seedream/download', {path});
    } else {
      control = document.createElement('input'); control.readOnly = true; control.value = path;
      control.setAttribute('aria-label', t('download')); control.addEventListener('focus', () => control.select());
    }
    row.append(label, control); $('downloads').prepend(row); status(t('exported', {format: format.toUpperCase()}));
  });
}
$('export').addEventListener('click', () => exportFile()); $('export-layer').addEventListener('click', () => exportFile(selected));
$('stage').addEventListener('pointerdown', event => {
  if (busy || draft.revision < latest()) return;
  const id = event.target.closest('[data-layer]')?.dataset.layer; if (!id) return;
  selected = id; paint(); $('stage').focus();
  drag = {pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: current().x, y: current().y};
  $('stage').setPointerCapture(event.pointerId); event.preventDefault();
});
$('stage').addEventListener('pointermove', event => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const rect = $('stage').getBoundingClientRect();
  patch({x: Math.round(Math.max(-32768, Math.min(32768, drag.x + (event.clientX - drag.clientX) * draft.width / rect.width))),
    y: Math.round(Math.max(-32768, Math.min(32768, drag.y + (event.clientY - drag.clientY) * draft.height / rect.height)))});
  inspector();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('stage').addEventListener(event, () => { drag = null; });
$('stage').addEventListener('keydown', event => {
  const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
  if (!direction || !current()) return;
  event.preventDefault(); const step = event.shiftKey ? 10 : 1;
  patch({x: current().x + direction[0] * step, y: current().y + direction[1] * step}); inspector();
});
addEventListener('message', event => {
  if (event.source !== parent || event.data?.jsonrpc !== '2.0') return;
  const data = event.data;
  if (data.id && pending.has(data.id)) {
    const request = pending.get(data.id); clearTimeout(request.timer); pending.delete(data.id);
    if (data.error) request.reject(new Error(t('error.unknown'))); else request.resolve(data.result);
  }
  if (data.method === 'ui/notifications/host-context-changed') localize(data.params);
  if (data.method === 'ui/notifications/tool-result' && data.params?._meta?.seedream_layers) {
    if (patches.size) status(t('incoming')); else if (accept(data.params)) status(t('ready', {count: draft.layers.length}));
  }
});
if (web) {
  $('font-choice').hidden = true;
  $('text-hint').dataset.i18n = 'textHintWeb';
  $('replace-hint').dataset.i18n = 'replaceHintWeb';
  $('replace-label').dataset.i18n = 'replaceLabelWeb';
  const replacement = $('replacement_path');
  replacement.type = 'file';
  replacement.accept = '.png,.jpg,.jpeg,.webp';
  replacement.addEventListener('change', async () => {
    const file = replacement.files[0];
    replacement.value = '';
    if (!file) return;
    let uploaded;
    await work(async () => { uploaded = await rpc('seedream/upload', {file}); });
    if (uploaded?.path) { patch({replacement_path: uploaded.path, text: null}); inspector(); status(t('replacementReady')); }
  });
}
localize({locale: navigator.language});
rpc('ui/initialize', {protocolVersion: '2026-01-26', appInfo: {name: 'seedream-layer-editor', version: '0.8.0'}, appCapabilities: {}})
  .then(result => { localize(result.hostContext); notify('ui/notifications/initialized', {}); resize(); })
  .catch(error => status(error.message, true));
