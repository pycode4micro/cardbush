import { AsyncLocalStorage } from 'node:async_hooks';
import { uiText, resolveUiLanguage } from '@cardbush/platform/i18n';
import { renderHtmlTemplate } from '@cardbush/platform/templates';
import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import WordExtractor from 'word-extractor';

const modernWordExtensions = new Set(['.docx']);
const spreadsheetExtensions = new Set(['.xls', '.xlsx']);
const presentationExtensions = new Set(['.ppt', '.pptx']);
const officePreviewExtensions = new Set([
  '.doc',
  ...modernWordExtensions,
  ...spreadsheetExtensions,
  ...presentationExtensions,
]);

const maxSpreadsheetRows = 500;
const maxSpreadsheetColumns = 100;
const maxSpreadsheetCells = 20_000;

type SpreadsheetStyle = {
  css: string;
  numberFormat: string;
};

type SpreadsheetLayout = {
  columnWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  hiddenColumns: Set<number>;
  hiddenRows: Set<number>;
  merges: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>;
};

type OfficeApp = 'word' | 'excel' | 'powerpoint';
type OfficeReaderKind = 'document' | 'workbook' | 'slides' | 'text';

export function isOfficePreviewPath(filePath: string) {
  return officePreviewExtensions.has(path.extname(filePath).toLowerCase());
}

const previewLanguage = new AsyncLocalStorage<string>();
const nativeText = () => uiText(previewLanguage.getStore() ?? 'en');
export async function renderOfficePreview(filePath: string, language = 'en') {
  return previewLanguage.run(resolveUiLanguage(language), () => renderOfficeDocument(filePath));
}

async function renderOfficeDocument(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const title = path.basename(filePath);
  const officeApp = officeAppForExtension(extension);
  try {
    if (modernWordExtensions.has(extension)) {
      return await renderDocx(filePath, title);
    }
    if (extension === '.doc') {
      return await renderLegacyDoc(filePath, title);
    }
    if (extension === '.xlsx') {
      return await renderXlsx(filePath, title);
    }
    if (extension === '.xls') {
      return await renderLegacyBinary(filePath, title, nativeText()('template.legacyExcel'), 'excel');
    }
    if (extension === '.pptx') {
      return await renderPptx(filePath, title);
    }
    if (extension === '.ppt') {
      return await renderLegacyBinary(filePath, title, nativeText()('template.legacyPowerpoint'), 'powerpoint');
    }
    return officeDocumentShell(title, nativeText()('template.office'), unsupportedDocumentBody());
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return officeDocumentShell(
      title,
      nativeText()('template.office'),
      `<section class="empty-state"><h2>${escapeHtml(nativeText()('template.previewUnavailable'))}</h2><p>${escapeHtml(message)}</p></section>`,
      { app: officeApp, readerKind: 'text' },
    );
  }
}

function officeAppForExtension(extension: string): OfficeApp {
  if (spreadsheetExtensions.has(extension)) return 'excel';
  if (presentationExtensions.has(extension)) return 'powerpoint';
  return 'word';
}

async function renderDocx(filePath: string, title: string) {
  const bytes = await fs.promises.readFile(filePath);
  const jsZipScript = await fs.promises.readFile(
    path.join(path.dirname(require.resolve('jszip')), '..', 'dist', 'jszip.min.js'),
    'utf8',
  );
  const docxPreviewScript = await fs.promises.readFile(
    path.join(path.dirname(require.resolve('docx-preview')), 'docx-preview.min.js'),
    'utf8',
  );
  return officeDocumentShell(
    title,
    nativeText()('template.word'),
    `<div id="docx-container" class="docx-container"><div class="office-loading">${escapeHtml(nativeText()('template.wordLoading'))}</div></div>`,
    {
      app: 'word',
      scripts: `${jsZipScript}\n${docxPreviewScript}\n${docxBootstrapScript(bytes.toString('base64'))}`,
    },
  );
}

function docxBootstrapScript(base64: string) {
  return renderHtmlTemplate('office-docx-script', {
    base64: base64,
    pageCount: nativeText()('template.pageCount', { count: '{count}' }),
    failureHeading: '<section class="empty-state"><h2>' + escapeHtml(nativeText()('template.wordFailed')) + '</h2><p>',
  });
}

async function renderLegacyDoc(filePath: string, title: string) {
  const extractor = new WordExtractor();
  const document = await extractor.extract(filePath);
  const body = document.getBody().trim();
  const headers = document.getHeaders().trim();
  const footers = document.getFooters().trim();
  const sections = [
    headers ? `<header class="legacy-section">${plainTextParagraphs(headers)}</header>` : '',
    body ? `<article class="word-document">${plainTextParagraphs(body)}</article>` : '',
    footers ? `<footer class="legacy-section">${plainTextParagraphs(footers)}</footer>` : '',
  ].filter(Boolean).join('');
  return officeDocumentShell(
    title,
    nativeText()('template.legacyWord'),
    sections || emptyDocumentBody(nativeText()('template.emptyWord')),
    { app: 'word', readerKind: 'text' },
  );
}

async function renderXlsx(filePath: string, title: string) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
  const sharedStrings = await readSharedStrings(zip);
  const stylesXml = await zip.file('xl/styles.xml')?.async('string') ?? '';
  const styles = parseSpreadsheetStyles(stylesXml);
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string') ?? '';
  const relationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string') ?? '';
  const relationships = relationshipTargets(relationshipsXml, 'xl');
  const sheets = workbookSheets(workbookXml, relationships);
  const renderedSheets: string[] = [];
  for (const [index, sheet] of sheets.entries()) {
    const worksheetXml = await zip.file(sheet.target)?.async('string') ?? '';
    renderedSheets.push(renderWorksheet(
      sheet.name,
      worksheetXml,
      sharedStrings,
      styles,
      index,
    ));
  }
  const navigation = sheets.length > 1
    ? `<nav class="sheet-navigation" role="tablist" aria-label="${escapeHtml(nativeText()('template.worksheets'))}">${sheets.map((sheet, index) =>
        `<button type="button" role="tab" data-sheet-index="${index}" aria-selected="${index === 0}" class="${index === 0 ? 'active' : ''}">${escapeHtml(sheet.name)}</button>`,
      ).join('')}</nav>`
    : '';
  return officeDocumentShell(
    title,
    nativeText()('template.workbookSheets', { count: sheets.length }),
    sheets.length > 0
      ? `${navigation}<div class="workbook">${renderedSheets.join('')}</div>`
      : emptyDocumentBody(nativeText()('template.emptyWorkbook')),
    { app: 'excel' },
  );
}

async function readSharedStrings(zip: JSZip) {
  const source = await zip.file('xl/sharedStrings.xml')?.async('string') ?? '';
  return [...source.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) =>
    xmlText(match[1]),
  );
}

function workbookSheets(workbookXml: string, relationships: Map<string, string>) {
  return [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)].map((match, index) => {
    const attributes = xmlAttributes(match[1]);
    const relationshipId = attributes['r:id'] ?? '';
    const target = relationships.get(relationshipId) ?? `xl/worksheets/sheet${index + 1}.xml`;
    return {
      name: decodeXmlEntities(attributes.name || `Sheet ${index + 1}`),
      target,
    };
  });
}

function renderWorksheet(
  name: string,
  worksheetXml: string,
  sharedStrings: string[],
  styles: SpreadsheetStyle[],
  sheetIndex: number,
) {
  const rows = new Map<number, Map<number, { value: string; style: SpreadsheetStyle }>>();
  const layout = spreadsheetLayout(worksheetXml);
  let cellCount = 0;
  let truncated = false;
  for (const match of worksheetXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    if (cellCount >= maxSpreadsheetCells) {
      truncated = true;
      break;
    }
    const attributes = xmlAttributes(match[1]);
    const location = spreadsheetCellLocation(attributes.r ?? '');
    if (!location || location.row > maxSpreadsheetRows || location.column > maxSpreadsheetColumns) {
      truncated = true;
      continue;
    }
    const style = styles[Number.parseInt(attributes.s ?? '0', 10)] ?? styles[0] ?? {
      css: '',
      numberFormat: '',
    };
    const value = spreadsheetCellValue(
      match[2],
      attributes.t ?? '',
      sharedStrings,
      style.numberFormat,
    );
    const row = rows.get(location.row) ?? new Map<number, { value: string; style: SpreadsheetStyle }>();
    row.set(location.column, { value, style });
    rows.set(location.row, row);
    cellCount += 1;
  }
  const maxColumn = Math.min(maxSpreadsheetColumns, Math.max(
    0,
    ...[...rows.values()].flatMap((row) => [...row.keys()]),
    ...layout.columnWidths.keys(),
    ...layout.merges.map((merge) => merge.endColumn),
  ));
  const maxRow = Math.min(maxSpreadsheetRows, Math.max(
    0,
    ...rows.keys(),
    ...layout.rowHeights.keys(),
    ...layout.merges.map((merge) => merge.endRow),
  ));
  const mergeStarts = new Map<string, { rowSpan: number; columnSpan: number }>();
  const mergedFollowers = new Set<string>();
  for (const merge of layout.merges) {
    mergeStarts.set(`${merge.startRow}:${merge.startColumn}`, {
      rowSpan: merge.endRow - merge.startRow + 1,
      columnSpan: merge.endColumn - merge.startColumn + 1,
    });
    for (let row = merge.startRow; row <= merge.endRow; row += 1) {
      for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
        if (row !== merge.startRow || column !== merge.startColumn) {
          mergedFollowers.add(`${row}:${column}`);
        }
      }
    }
  }
  const columns = maxColumn > 0
    ? `<colgroup><col class="excel-row-heading" />${Array.from(
        { length: maxColumn },
        (_, index) => {
          const column = index + 1;
          const width = layout.columnWidths.get(column) ?? 88;
          return `<col style="width:${width}px;${layout.hiddenColumns.has(column) ? 'display:none;' : ''}" />`;
        },
      ).join('')}</colgroup>`
    : '';
  const header = maxColumn > 0
    ? `<thead><tr><th class="row-number"></th>${Array.from(
        { length: maxColumn },
        (_, index) => `<th${layout.hiddenColumns.has(index + 1) ? ' style="display:none"' : ''}>${spreadsheetColumnLabel(index + 1)}</th>`,
      ).join('')}</tr></thead>`
    : '';
  const body = maxRow > 0
    ? `<tbody>${Array.from({ length: maxRow }, (_, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const row = rows.get(rowNumber);
        const rowStyle = [
          layout.rowHeights.has(rowNumber) ? `height:${layout.rowHeights.get(rowNumber)}px` : '',
          layout.hiddenRows.has(rowNumber) ? 'display:none' : '',
        ].filter(Boolean).join(';');
        const cells: string[] = [];
        for (let column = 1; column <= maxColumn; column += 1) {
          const key = `${rowNumber}:${column}`;
          if (mergedFollowers.has(key)) continue;
          const cell = row?.get(column);
          const merge = mergeStarts.get(key);
          const attributes = [
            merge?.rowSpan && merge.rowSpan > 1 ? `rowspan="${merge.rowSpan}"` : '',
            merge?.columnSpan && merge.columnSpan > 1 ? `colspan="${merge.columnSpan}"` : '',
            cell?.style.css || layout.hiddenColumns.has(column)
              ? `style="${cell?.style.css ?? ''}${layout.hiddenColumns.has(column) ? 'display:none;' : ''}"`
              : '',
            `data-cell="${spreadsheetColumnLabel(column)}${rowNumber}"`,
          ].filter(Boolean).join(' ');
          cells.push(`<td ${attributes}>${escapeHtml(cell?.value ?? '')}</td>`);
        }
        return `<tr${rowStyle ? ` style="${rowStyle}"` : ''}><th class="row-number">${rowNumber}</th>${cells.join('')}</tr>`;
      }).join('')}</tbody>`
    : '';
  return `<section class="worksheet" id="sheet-${sheetIndex + 1}" data-sheet="${sheetIndex}"${sheetIndex === 0 ? '' : ' hidden'}>
    <div class="worksheet-title"><span class="excel-grid-icon">▦</span><h2>${escapeHtml(name)}</h2></div>
    ${truncated ? `<p class="limit-notice">${escapeHtml(nativeText()('template.sheetLimit'))}</p>` : ''}
    ${maxRow > 0 ? `<div class="excel-formula-bar"><span>fx</span><div>${escapeHtml(nativeText()('template.readOnly'))}</div></div><div class="table-scroll"><table>${columns}${header}${body}</table></div>` : `<p class="empty-sheet">${escapeHtml(nativeText()('template.emptySheet'))}</p>`}
  </section>`;
}

function spreadsheetCellValue(
  source: string,
  type: string,
  sharedStrings: string[],
  numberFormat = '',
) {
  if (type === 'inlineStr') {
    return xmlText(source);
  }
  const raw = decodeXmlEntities(source.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '');
  if (type === 's') {
    return sharedStrings[Number.parseInt(raw, 10)] ?? '';
  }
  if (type === 'b') {
    return raw === '1' ? 'TRUE' : 'FALSE';
  }
  return formatSpreadsheetValue(raw, numberFormat);
}

function spreadsheetLayout(source: string): SpreadsheetLayout {
  const columnWidths = new Map<number, number>();
  const rowHeights = new Map<number, number>();
  const hiddenColumns = new Set<number>();
  const hiddenRows = new Set<number>();
  for (const match of source.matchAll(/<col\b([^>]*)\/?\s*>/gi)) {
    const attributes = xmlAttributes(match[1]);
    const start = Number.parseInt(attributes.min ?? '0', 10);
    const end = Number.parseInt(attributes.max ?? attributes.min ?? '0', 10);
    const width = Math.max(24, Math.min(420, Math.round((Number(attributes.width) || 12) * 7 + 5)));
    for (let column = start; column <= Math.min(end, maxSpreadsheetColumns); column += 1) {
      columnWidths.set(column, width);
      if (attributes.hidden === '1') hiddenColumns.add(column);
    }
  }
  for (const match of source.matchAll(/<row\b([^>]*)>/gi)) {
    const attributes = xmlAttributes(match[1]);
    const row = Number.parseInt(attributes.r ?? '0', 10);
    if (row > 0 && attributes.ht) rowHeights.set(row, Math.round(Number(attributes.ht) * 4 / 3));
    if (row > 0 && attributes.hidden === '1') hiddenRows.add(row);
  }
  const merges = [...source.matchAll(/<mergeCell\b([^>]*)\/?\s*>/gi)].flatMap((match) => {
    const reference = xmlAttributes(match[1]).ref ?? '';
    const [start, end = start] = reference.split(':');
    const startLocation = spreadsheetCellLocation(start);
    const endLocation = spreadsheetCellLocation(end);
    return startLocation && endLocation ? [{
      startRow: startLocation.row,
      startColumn: startLocation.column,
      endRow: endLocation.row,
      endColumn: endLocation.column,
    }] : [];
  });
  return { columnWidths, rowHeights, hiddenColumns, hiddenRows, merges };
}

function parseSpreadsheetStyles(source: string): SpreadsheetStyle[] {
  if (!source) return [{ css: '', numberFormat: '' }];
  const numberFormats = new Map<number, string>([
    [9, '0%'], [10, '0.00%'], [14, 'm/d/yy'], [15, 'd-mmm-yy'],
    [16, 'd-mmm'], [17, 'mmm-yy'], [18, 'h:mm AM/PM'], [20, 'h:mm'],
    [22, 'm/d/yy h:mm'], [37, '#,##0 ;(#,##0)'], [38, '#,##0 ;[Red](#,##0)'],
  ]);
  for (const match of source.matchAll(/<numFmt\b([^>]*)\/?\s*>/gi)) {
    const attributes = xmlAttributes(match[1]);
    numberFormats.set(Number(attributes.numFmtId), decodeXmlEntities(attributes.formatCode ?? ''));
  }
  const fonts = xmlSectionBlocks(source, 'fonts', 'font').map(spreadsheetFontCss);
  const fills = xmlSectionBlocks(source, 'fills', 'fill').map(spreadsheetFillCss);
  const borders = xmlSectionBlocks(source, 'borders', 'border').map(spreadsheetBorderCss);
  const cellXfsSection = source.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i)?.[1] ?? '';
  const styles = [...cellXfsSection.matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/gi)].map((match) => {
    const attributes = xmlAttributes(match[1]);
    const alignment = spreadsheetAlignmentCss(match[2] ?? '');
    return {
      css: [
        fonts[Number(attributes.fontId)] ?? '',
        fills[Number(attributes.fillId)] ?? '',
        borders[Number(attributes.borderId)] ?? '',
        alignment,
      ].filter(Boolean).join(''),
      numberFormat: numberFormats.get(Number(attributes.numFmtId)) ?? '',
    };
  });
  return styles.length > 0 ? styles : [{ css: '', numberFormat: '' }];
}

function xmlSectionBlocks(source: string, section: string, item: string) {
  const body = source.match(new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)<\\/${section}>`, 'i'))?.[1] ?? '';
  return [...body.matchAll(new RegExp(`<${item}\\b[^>]*>([\\s\\S]*?)<\\/${item}>`, 'gi'))]
    .map((match) => match[1]);
}

function spreadsheetFontCss(source: string) {
  const name = xmlChildAttributes(source, 'name').val || 'Calibri';
  const size = Number(xmlChildAttributes(source, 'sz').val) || 11;
  const color = spreadsheetColor(xmlChildAttributes(source, 'color'));
  return [
    `font-family:${cssValue(name)},"Microsoft YaHei",sans-serif;`,
    `font-size:${size}pt;`,
    /<b\b/i.test(source) ? 'font-weight:700;' : '',
    /<i\b/i.test(source) ? 'font-style:italic;' : '',
    /<u\b/i.test(source) ? 'text-decoration:underline;' : '',
    color ? `color:${color};` : '',
  ].join('');
}

function spreadsheetFillCss(source: string) {
  const pattern = xmlChildAttributes(source, 'patternFill');
  if (pattern.patternType && pattern.patternType !== 'none') {
    const color = spreadsheetColor(xmlChildAttributes(source, 'fgColor'));
    if (color) return `background-color:${color};`;
  }
  const gradientStops = [...source.matchAll(/<stop\b[^>]*>([\s\S]*?)<\/stop>/gi)]
    .map((match) => spreadsheetColor(xmlChildAttributes(match[1], 'color')))
    .filter(Boolean);
  return gradientStops.length > 1
    ? `background:linear-gradient(90deg,${gradientStops.join(',')});`
    : '';
}

function spreadsheetBorderCss(source: string) {
  return ['top', 'right', 'bottom', 'left'].map((side) => {
    const block = source.match(new RegExp(`<${side}\\b([^>]*)>([\\s\\S]*?)<\\/${side}>|<${side}\\b([^>]*)\\/>`, 'i'));
    const attributes = xmlAttributes(block?.[1] ?? block?.[3] ?? '');
    if (!attributes.style) return '';
    const color = spreadsheetColor(xmlChildAttributes(block?.[2] ?? '', 'color')) || '#b7b7b7';
    const borderStyle = attributes.style.includes('dash') ? 'dashed' : attributes.style === 'dotted' ? 'dotted' : 'solid';
    const width = /medium|thick|double/i.test(attributes.style) ? 2 : 1;
    return `border-${side}:${width}px ${borderStyle} ${color};`;
  }).join('');
}

function spreadsheetAlignmentCss(source: string) {
  const attributes = xmlChildAttributes(source, 'alignment');
  return [
    attributes.horizontal ? `text-align:${attributes.horizontal === 'centerContinuous' ? 'center' : attributes.horizontal};` : '',
    attributes.vertical ? `vertical-align:${attributes.vertical === 'center' ? 'middle' : attributes.vertical};` : '',
    attributes.wrapText === '1' ? 'white-space:pre-wrap;overflow-wrap:anywhere;' : '',
    attributes.textRotation ? `transform:rotate(${Math.min(90, Number(attributes.textRotation) || 0)}deg);` : '',
    attributes.indent ? `padding-left:${8 + Number(attributes.indent) * 10}px;` : '',
  ].join('');
}

function xmlChildAttributes(source: string, tag: string) {
  const match = source.match(new RegExp(`<${tag}\\b([^>]*)\\/?\\s*>`, 'i'));
  return xmlAttributes(match?.[1] ?? '');
}

function spreadsheetColor(attributes: Record<string, string>) {
  if (attributes.rgb) return `#${attributes.rgb.slice(-6)}`;
  const indexed = Number(attributes.indexed);
  if (Number.isFinite(indexed)) {
    return ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'][indexed] ?? '';
  }
  const themes = ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];
  return themes[Number(attributes.theme)] ?? '';
}

function formatSpreadsheetValue(raw: string, format: string) {
  const numeric = Number(raw);
  if (!raw || !Number.isFinite(numeric) || !format) return raw;
  if (format.includes('%')) {
    const decimals = (format.match(/0\.(0+)/)?.[1].length ?? 0);
    return `${(numeric * 100).toFixed(decimals)}%`;
  }
  if (/[ymdhis]/i.test(format) && numeric > 0) {
    const date = new Date(Date.UTC(1899, 11, 30) + numeric * 86_400_000);
    if (!Number.isNaN(date.getTime())) {
      const hasTime = /[his]/i.test(format);
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        ...(hasTime ? { hour: '2-digit', minute: '2-digit' } : {}),
        timeZone: 'UTC',
      }).format(date);
    }
  }
  if (format.includes(',')) return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: format.match(/\.([0#]+)/)?.[1].replace(/#/g, '').length ?? 0,
    maximumFractionDigits: format.match(/\.([0#]+)/)?.[1].length ?? 0,
  }).format(numeric);
  return raw;
}

function cssValue(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function spreadsheetCellLocation(reference: string) {
  const match = /^([A-Z]+)(\d+)$/i.exec(reference);
  if (!match) return null;
  let column = 0;
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { column, row: Number.parseInt(match[2], 10) };
}

function spreadsheetColumnLabel(column: number) {
  let value = column;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

async function renderPptx(filePath: string, title: string) {
  // Keep compatibility URLs on the same PPTX engine instead of approximating
  // shape geometry, fonts and media with a separate HTML converter.
  const target = 'cardbush-file://office-preview/?path=' + encodeURIComponent(filePath);
  return renderHtmlTemplate('office-redirect', { language: previewLanguage.getStore() ?? 'en', title, target, open: nativeText()('template.openPresentation') });
}

async function renderLegacyBinary(
  filePath: string,
  title: string,
  kind: string,
  app: OfficeApp,
) {
  const bytes = await fs.promises.readFile(filePath);
  const recovered = recoverBinaryOfficeText(bytes);
  return officeDocumentShell(
    title,
    nativeText()('template.kindText', { kind }),
    recovered.length > 0
      ? `<article class="legacy-binary">${recovered.map((value) => `<p>${escapeHtml(value)}</p>`).join('')}</article>`
      : emptyDocumentBody(nativeText()('template.legacyEmpty')),
    { app, readerKind: 'text' },
  );
}

function recoverBinaryOfficeText(bytes: Buffer) {
  const candidates = [
    ...extractPrintableRuns(bytes.toString('latin1'), /[^\x20-\x7e\xa0-\xff]+/g),
    ...(hasLikelyUtf16LeText(bytes)
      ? extractPrintableRuns(bytes.toString('utf16le'), /[^\u0020-\u007e\u00a0-\uffff]+/g)
      : []),
  ];
  const seen = new Set<string>();
  return candidates
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value.length >= 4 && /[\p{L}\p{N}]/u.test(value))
    .filter((value) => {
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 1200);
}

function hasLikelyUtf16LeText(bytes: Buffer) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return true;
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 32_768);
  if (sampleLength < 8) return false;
  let printableAsciiWithNull = 0;
  let pairs = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    pairs += 1;
    if (bytes[index] >= 0x20 && bytes[index] <= 0x7e && bytes[index + 1] === 0) {
      printableAsciiWithNull += 1;
    }
  }
  return printableAsciiWithNull / pairs >= 0.08;
}

function extractPrintableRuns(value: string, separator: RegExp) {
  return value.split(separator);
}

function relationshipTargets(source: string, basePath: string) {
  const result = new Map<string, string>();
  for (const match of source.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = xmlAttributes(match[1]);
    if (!attributes.Id || !attributes.Target || attributes.TargetMode === 'External') continue;
    const target = decodeXmlEntities(attributes.Target).replace(/\\/g, '/');
    result.set(
      attributes.Id,
      target.startsWith('/')
        ? path.posix.normalize(target.replace(/^\/+/, ''))
        : path.posix.normalize(path.posix.join(basePath, target)),
    );
  }
  return result;
}

function xmlAttributes(source: string) {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
    result[match[1]] = match[2];
  }
  return result;
}

function xmlText(source: string) {
  return [...source.matchAll(/<(?:a:|w:)?t\b[^>]*>([\s\S]*?)<\/(?:a:|w:)?t>/gi)]
    .map((match) => decodeXmlEntities(match[1]))
    .join('');
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function plainTextParagraphs(value: string) {
  return value
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('');
}

function emptyDocumentBody(message: string) {
  return `<section class="empty-state"><p>${escapeHtml(message)}</p></section>`;
}

function unsupportedDocumentBody() {
  return emptyDocumentBody(nativeText()('template.unsupported'));
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function officeReaderToolbarMarkup(app: OfficeApp, readerKind: OfficeReaderKind) {
  const navigation = readerKind === 'slides'
    ? renderHtmlTemplate('office-slide-navigation', { previousSlide: nativeText()("template.previousSlide"), nextSlide: nativeText()("template.nextSlide") })
    : '';
  const viewOptions = readerKind === 'workbook'
    ? renderHtmlTemplate('office-sheet-options', { gridlines: nativeText()("template.gridlines"), cellValues: nativeText()("template.cellValues") })
    : '';
  const fitLabel = app === 'word' ? nativeText()('template.fitWidth') : nativeText()('template.fitWindow');
  return renderHtmlTemplate('office-toolbar', { fitLabel: fitLabel,
    toolbar: nativeText()("template.toolbar"),
    zoom: nativeText()("template.zoom"),
    zoomOut: nativeText()("template.zoomOut"),
    zoomReset: nativeText()("template.zoomReset"),
    zoomIn: nativeText()("template.zoomIn") }, { navigation: navigation,
    viewOptions: viewOptions });
}

function officeInteractionScript(readerKind: OfficeReaderKind) {
  return renderHtmlTemplate('office-reader-script', {
    readerKind: readerKind,
    sheetNumber: nativeText()('template.sheetNumber', { index: '{index}' }),
    slideNumber: nativeText()('template.slideNumber', { index: '{index}', count: '{count}' }),
    gridHidden: nativeText()('template.gridHidden'),
    gridShown: nativeText()('template.gridShown'),
    formulaHidden: nativeText()('template.formulaHidden'),
    formulaShown: nativeText()('template.formulaShown'),
  });
}

function officeDocumentShell(
  title: string,
  subtitle: string,
  body: string,
  options: { app?: OfficeApp; readerKind?: OfficeReaderKind; scripts?: string } = {},
) {
  const officeApp: OfficeApp = options.app ?? 'word';
  const readerKind: OfficeReaderKind = options.readerKind ?? (
    officeApp === 'excel' ? 'workbook' : officeApp === 'powerpoint' ? 'slides' : 'document'
  );
  const appName = officeApp === 'excel'
    ? 'Excel'
    : officeApp === 'powerpoint'
      ? 'PowerPoint'
      : 'Word';
  const appMark = officeApp === 'excel' ? 'X' : officeApp === 'powerpoint' ? 'P' : 'W';
  const scriptSource = `${options.scripts ?? ''}\n${officeInteractionScript(readerKind)}`;
  const scripts = `<script>${scriptSource.replace(/<\/script/gi, '<\\/script')}</script>`;
  return renderHtmlTemplate('office-preview', { title: title,
    app: officeApp,
    appMark: appMark,
    appName: appName,
    subtitle: subtitle,
    language: previewLanguage.getStore() ?? 'en',
    readOnly: nativeText()("template.readOnly"),
    contentLabel: nativeText()('template.content', { app: appName }) }, { toolbar: officeReaderToolbarMarkup(officeApp, readerKind),
    body: body,
    scripts: scripts });
}
