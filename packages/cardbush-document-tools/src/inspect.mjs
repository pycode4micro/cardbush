// SPDX-License-Identifier: Apache-2.0
import { extname, posix } from 'node:path';
import { assertFormat, absolute, elements, fileBytes, fingerprint, officePackage, part } from './files.mjs';
import { pdfReader } from './sdk.mjs';

const clip = (value, limit = 1000) => String(value ?? '').slice(0, limit);
const text = node => elements(node, 't').map(item => item.textContent).join('');
const textItem = (value, limit) => ({ text: clip(value, limit), textTruncated: String(value ?? '').length > limit });
const columnIndex = address => [...address.replace(/\d/g, '')].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
export async function inspectDocument(kind, request) {
  const path = absolute(request.path); assertFormat(kind, path);
  const sha256 = await fingerprint(path);
  if (request.expected_sha256 && request.expected_sha256 !== sha256) throw new Error('Document changed. Inspect again before continuing.');
  const bytes = await fileBytes(path), offset = request.offset ?? 0, limit = request.limit ?? 20;
  let result;
  if (kind === 'pdf') {
    const reader = await pdfReader(bytes);
    try {
      const pages = [];
      for (let index = offset; index < Math.min(reader.document.numPages, offset + Math.min(limit, 5)); index++) {
        const page = await reader.document.getPage(index + 1), content = await page.getTextContent();
        const raw = content.items.map(item => item.str ?? '').join(' ');
        pages.push({ page: index + 1, text: clip(raw, 8000), textTruncated: raw.length > 8000 });
        page.cleanup();
      }
      result = { pageCount: reader.document.numPages, pages, nextOffset: offset + pages.length < reader.document.numPages ? offset + pages.length : null,
        note: 'Text extraction does not perform OCR. Render scanned pages to inspect them.' };
    } finally { await reader.close(); }
  } else if (kind === 'docx' && extname(path).toLowerCase() === '.doc') {
    const { default: WordExtractor } = await import('word-extractor');
    const doc = await new WordExtractor().extract(bytes), paragraphs = doc.getBody().split(/\r?\n/);
    result = { legacyFormat: true, paragraphCount: paragraphs.length, paragraphs: paragraphs.slice(offset, offset + limit).map((value, index) => ({ index: offset + index, ...textItem(value, 2000) })),
      nextOffset: offset + limit < paragraphs.length ? offset + limit : null, note: 'Read-only legacy DOC extraction. Convert explicitly to DOCX before editing.' };
  } else {
    const zip = await officePackage(bytes);
    if (kind === 'xlsx') result = await inspectWorkbook(zip, request, offset, limit);
    if (kind === 'docx') {
      const body = await part(zip, 'word/document.xml'), paragraphs = elements(body, 'p');
      result = { paragraphCount: paragraphs.length, tableCount: elements(body, 'tbl').length,
        paragraphs: paragraphs.slice(offset, offset + limit).map((p, index) => ({ index: offset + index, ...textItem(text(p), 2000) })),
        nextOffset: offset + limit < paragraphs.length ? offset + limit : null };
    }
    if (kind === 'pptx') {
      const document = await part(zip, 'ppt/presentation.xml');
      const rels = elements(await part(zip, 'ppt/_rels/presentation.xml.rels'), 'Relationship');
      const slides = elements(document, 'sldId');
      const pages = [];
      for (const [index, slide] of slides.slice(offset, offset + Math.min(limit, 5)).entries()) {
        const rel = rels.find(r => r.getAttribute('Id') === slide.getAttribute('r:id'));
        if (!rel || rel.getAttribute('TargetMode') === 'External') throw new Error('Invalid slide reference.');
        const target = rel.getAttribute('Target');
        const member = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('ppt', target));
        if (!member.startsWith('ppt/slides/')) throw new Error('Slide reference escapes its package.');
        const page = await part(zip, member), paragraphs = elements(page, 'p');
        pages.push({ page: offset + index + 1, part: member, paragraphs: paragraphs.slice(0, 30).map((p, index) => ({ index, ...textItem(text(p), 256) })),
          paragraphsTruncated: paragraphs.length > 30, imageCount: elements(page, 'pic').length, chartCount: elements(page, 'chart').length });
      }
      result = { pageCount: slides.length, pages, nextOffset: offset + pages.length < slides.length ? offset + pages.length : null };
    }
  }
  if (await fingerprint(path) !== sha256) throw new Error('Document changed during inspection; discard this result and retry.');
  const key = result.pages ? 'pages' : result.rows ? 'rows' : 'paragraphs';
  while (result[key]?.length > 1 && JSON.stringify(result).length > 12000) {
    result[key].pop(); result.nextOffset = offset + result[key].length;
  }
  // A wide row can exceed the budget even when only one row is returned.
  // Keep a column cursor instead of letting the host truncate the result JSON.
  const row = result.rows?.[0];
  while (row?.cells.length > 1 && JSON.stringify(result).length > 12000) {
    row.nextColumn = columnIndex(row.cells.pop().address);
  }
  return { path, format: kind, sha256, ...result };
}

async function inspectWorkbook(zip, request, offset, limit) {
  const book = await part(zip, 'xl/workbook.xml');
  const sheets = elements(book, 'sheet');
  const chosen = request.sheet ? sheets.find(sheet => sheet.getAttribute('name') === request.sheet) : sheets[0];
  if (!chosen) throw new Error('Worksheet not found.');
  const rels = elements(await part(zip, 'xl/_rels/workbook.xml.rels'), 'Relationship');
  const link = rels.find(rel => rel.getAttribute('Id') === chosen.getAttribute('r:id'));
  if (!link || link.getAttribute('TargetMode') === 'External') throw new Error('Invalid worksheet reference.');
  const target = link.getAttribute('Target');
  const member = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target));
  if (!member.startsWith('xl/worksheets/')) throw new Error('Unsupported worksheet type.');
  const shared = zip.file('xl/sharedStrings.xml') ? elements(await part(zip, 'xl/sharedStrings.xml'), 'si') : [];
  const rows = elements(await part(zip, member), 'row');
  const items = rows.slice(offset, offset + limit).map(row => {
    const cells = elements(row, 'c');
    const column = cell => columnIndex(cell.getAttribute('r'));
    const start = request.start_column ?? 1, selected = cells.filter(cell => column(cell) >= start && column(cell) < start + 40);
    return { row: row.getAttribute('r'), cells: selected.map(cell => {
      const type = cell.getAttribute('t'), value = elements(cell, 'v')[0]?.textContent;
      const formula = elements(cell, 'f')[0]?.textContent;
      const raw = type === 's' ? text(shared[Number(value)] ?? cell) : type === 'inlineStr' ? text(cell) : value;
      return { address: cell.getAttribute('r'), type: type || 'number', value: clip(raw, 200), valueTruncated: String(raw ?? '').length > 200,
        ...(formula !== undefined ? { formula: clip(formula, 200), formulaTruncated: formula.length > 200, cachedValuePresent: value !== undefined && (value !== '' || type === 'str') } : {}) };
    }), nextColumn: cells.some(cell => column(cell) >= start + 40) ? start + 40 : null };
  });
  return { sheetCount: sheets.length, sheets: sheets.slice(0, 200).map(sheet => sheet.getAttribute('name')), sheetsTruncated: sheets.length > 200, sheet: chosen.getAttribute('name'),
    populatedRows: rows.length, rows: items, nextOffset: offset + limit < rows.length ? offset + limit : null,
    note: 'offset counts populated rows. Values retain their serialized precision; cached formula values may be stale. Inspect is read-only and never recalculates.' };
}

export async function validateDocument(kind, path) {
  assertFormat(kind, path);
  const bytes = await fileBytes(path);
  if (kind === 'pdf') {
    const reader = await pdfReader(bytes);
    try { return { structure: 'readable', pages: reader.document.numPages, visual: 'not_checked' }; }
    finally { await reader.close(); }
  }
  const zip = await officePackage(bytes);
  const name = { xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml', docx: 'word/document.xml' }[kind];
  const document = await part(zip, name);
  if (document.documentElement.localName !== { xlsx: 'workbook', pptx: 'presentation', docx: 'document' }[kind]) throw new Error('Invalid Office document root.');
  let formulas = 0, missingCaches = 0, errorCount = 0;
  if (kind === 'xlsx') for (const member of Object.keys(zip.files).filter(name => /^xl\/worksheets\/[^/]+\.xml$/.test(name))) {
    for (const cell of elements(await part(zip, member), 'c')) {
      if (elements(cell, 'f').length) {
        formulas++;
        if (!elements(cell, 'v').length || (elements(cell, 'v')[0].textContent === '' && cell.getAttribute('t') !== 'str')) missingCaches++;
      }
      if (cell.getAttribute('t') === 'e') errorCount++;
    }
  }
  return { structure: 'package_checked', visual: 'not_checked', ...(kind === 'xlsx' ? { formulas, missingCaches, errorCount,
    calculation: formulas ? 'not_verified' : 'not_needed' } : {}) };
}

// Conversion must not silently replace formulas with values or drop worksheets.
export async function workbookStructure(zip, rejectExternalFormulas = false) {
  const sheets = elements(await part(zip, 'xl/workbook.xml'), 'sheet');
  const rels = elements(await part(zip, 'xl/_rels/workbook.xml.rels'), 'Relationship');
  const result = [];
  for (const sheet of sheets) {
    const rel = rels.find(item => item.getAttribute('Id') === sheet.getAttribute('r:id'));
    if (!rel || rel.getAttribute('TargetMode') === 'External') throw new Error('Invalid worksheet reference.');
    const target = rel.getAttribute('Target');
    const member = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target));
    if (!member.startsWith('xl/worksheets/')) throw new Error('Unsupported worksheet type.');
    const formulas = [];
    for (const cell of elements(await part(zip, member), 'c')) {
      const formula = elements(cell, 'f')[0];
      if (!formula) continue;
      if (rejectExternalFormulas && /(?:\b(?:WEBSERVICE|DDE|RTD|CUBEVALUE|CUBEMEMBER)\s*\(|\[[^\]]+\][^!]*!)/i.test(formula.textContent)) throw new Error('Recalculation of formulas using external services/references is unsupported.');
      formulas.push(cell.getAttribute('r'));
    }
    result.push({ name: sheet.getAttribute('name'), formulas: formulas.sort() });
  }
  return result;
}
