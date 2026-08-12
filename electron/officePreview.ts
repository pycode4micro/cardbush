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

export function isOfficePreviewPath(filePath: string) {
  return officePreviewExtensions.has(path.extname(filePath).toLowerCase());
}

export async function renderOfficePreview(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const title = path.basename(filePath);
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
      return await renderLegacyBinary(filePath, title, '旧版 Excel 工作簿');
    }
    if (extension === '.pptx') {
      return await renderPptx(filePath, title);
    }
    if (extension === '.ppt') {
      return await renderLegacyBinary(filePath, title, '旧版 PowerPoint 演示文稿');
    }
    return officeDocumentShell(title, 'Office 文档', unsupportedDocumentBody());
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return officeDocumentShell(
      title,
      'Office 文档',
      `<section class="empty-state"><h2>无法生成预览</h2><p>${escapeHtml(message)}</p></section>`,
    );
  }
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
    'Word 文档 · 页面布局',
    '<div id="docx-container" class="docx-container"><div class="office-loading">正在还原 Word 页面与样式…</div></div>',
    {
      app: 'word',
      scripts: `${jsZipScript}\n${docxPreviewScript}\n${docxBootstrapScript(bytes.toString('base64'))}`,
    },
  );
}

function docxBootstrapScript(base64: string) {
  return `
    (() => {
      const binary = atob(${JSON.stringify(base64)});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const container = document.getElementById('docx-container');
      docx.renderAsync(bytes.buffer, container, container, {
        className: 'docx',
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        ignoreFonts: false,
        useBase64URL: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: true,
        experimental: true,
      }).then(() => {
        const fitPages = () => {
          const page = container.querySelector('section.docx');
          const wrapper = container.querySelector('.docx-wrapper');
          if (!page || !wrapper) return;
          const available = Math.max(260, container.clientWidth - 44);
          const scale = Math.max(0.42, Math.min(1, available / page.offsetWidth));
          wrapper.style.setProperty('--docx-preview-scale', String(scale));
        };
        fitPages();
        new ResizeObserver(fitPages).observe(container);
      }).catch((error) => {
        container.innerHTML = '<section class="empty-state"><h2>Word 样式渲染失败</h2><p>' +
          String(error && error.message || error).replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])) +
          '</p></section>';
      });
    })();
  `;
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
    '旧版 Word 文档',
    sections || emptyDocumentBody('文档中没有可提取的文字。'),
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
    ? `<nav class="sheet-navigation">${sheets.map((sheet, index) =>
        `<a href="#sheet-${index + 1}">${escapeHtml(sheet.name)}</a>`,
      ).join('')}</nav>`
    : '';
  return officeDocumentShell(
    title,
    `Excel 工作簿 · ${sheets.length} 个工作表`,
    sheets.length > 0
      ? `${navigation}<div class="workbook">${renderedSheets.join('')}</div>`
      : emptyDocumentBody('工作簿中没有可显示的工作表。'),
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
  return `<section class="worksheet" id="sheet-${sheetIndex + 1}">
    <div class="worksheet-title"><span class="excel-grid-icon">▦</span><h2>${escapeHtml(name)}</h2></div>
    ${truncated ? '<p class="limit-notice">内容较大，预览仅显示前 500 行、100 列或 20,000 个单元格。</p>' : ''}
    ${maxRow > 0 ? `<div class="excel-formula-bar"><span>fx</span><div>只读预览</div></div><div class="table-scroll"><table>${columns}${header}${body}</table></div>` : '<p class="empty-sheet">空工作表</p>'}
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
  const bytes = await fs.promises.readFile(filePath);
  const jsZipScript = await fs.promises.readFile(
    path.join(path.dirname(require.resolve('jszip')), '..', 'dist', 'jszip.min.js'),
    'utf8',
  );
  const nodeModulesRoot = path.resolve(path.dirname(require.resolve('jszip')), '..', '..');
  const pptxModulePath = path.join(
    nodeModulesRoot,
    '@jvmr',
    'pptx-to-html',
    'dist',
    'index.js',
  );
  const pptxRendererScript = (await fs.promises.readFile(pptxModulePath, 'utf8'))
    .replace(/^import JSZip from ["']jszip["'];?\s*/m, 'const JSZip = globalThis.JSZip;\n')
    .replace(/export\s*\{\s*pptxToHtml\s*\};?\s*$/m, 'globalThis.pptxToHtml = pptxToHtml;');
  return officeDocumentShell(
    title,
    'PowerPoint 演示文稿 · 画布布局',
    '<div id="pptx-container" class="slide-deck"><div class="office-loading">正在还原幻灯片主题与画布…</div></div>',
    {
      app: 'powerpoint',
      scripts: `${jsZipScript}\n${pptxRendererScript}\n${pptxBootstrapScript(bytes.toString('base64'))}`,
    },
  );
}

function pptxBootstrapScript(base64: string) {
  return `
    (() => {
      const binary = atob(${JSON.stringify(base64)});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const container = document.getElementById('pptx-container');
      globalThis.pptxToHtml(bytes.buffer, { width: 960, height: 540, scaleToFit: true, letterbox: true })
        .then((slides) => {
          container.innerHTML = '';
          for (let index = 0; index < slides.length; index += 1) {
            const stage = document.createElement('section');
            stage.className = 'slide-stage';
            const number = document.createElement('div');
            number.className = 'slide-stage-number';
            number.textContent = String(index + 1);
            const canvas = document.createElement('div');
            canvas.className = 'slide-stage-canvas';
            canvas.innerHTML = slides[index];
            stage.append(number, canvas);
            container.append(stage);
          }
          const fitSlides = () => {
            container.querySelectorAll('.slide-stage-canvas').forEach((canvas) => {
              const viewport = canvas.querySelector('.slide-container');
              if (!viewport) return;
              const scale = Math.max(0.25, Math.min(1, canvas.clientWidth / 960));
              viewport.style.transformOrigin = 'top left';
              viewport.style.transform = 'scale(' + scale + ')';
            });
          };
          fitSlides();
          new ResizeObserver(fitSlides).observe(container);
        })
        .catch((error) => {
          container.innerHTML = '<section class="empty-state"><h2>PowerPoint 样式渲染失败</h2><p>' +
            String(error && error.message || error).replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])) +
            '</p></section>';
        });
    })();
  `;
}

async function renderLegacyBinary(filePath: string, title: string, kind: string) {
  const bytes = await fs.promises.readFile(filePath);
  const recovered = recoverBinaryOfficeText(bytes);
  return officeDocumentShell(
    title,
    `${kind} · 文本预览`,
    recovered.length > 0
      ? `<article class="legacy-binary">${recovered.map((value) => `<p>${escapeHtml(value)}</p>`).join('')}</article>`
      : emptyDocumentBody('旧版二进制文件中没有可安全提取的文字，请使用右键菜单在系统应用中打开。'),
  );
}

function recoverBinaryOfficeText(bytes: Buffer) {
  const candidates = [
    ...extractPrintableRuns(bytes.toString('utf16le'), /[^\u0020-\u007e\u00a0-\uffff]+/g),
    ...extractPrintableRuns(bytes.toString('latin1'), /[^\x20-\x7e\xa0-\xff]+/g),
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

function sanitizeConvertedHtml(value: string) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(["']).*?\1/gi, '')
    .replace(/(?:javascript|vbscript):/gi, '');
}

function emptyDocumentBody(message: string) {
  return `<section class="empty-state"><p>${escapeHtml(message)}</p></section>`;
}

function unsupportedDocumentBody() {
  return emptyDocumentBody('暂不支持此文件格式。');
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function officeDocumentShell(
  title: string,
  subtitle: string,
  body: string,
  options: { app?: 'word' | 'excel' | 'powerpoint'; scripts?: string } = {},
) {
  const appName = options.app === 'excel'
    ? 'Excel'
    : options.app === 'powerpoint'
      ? 'PowerPoint'
      : options.app === 'word'
        ? 'Word'
        : 'Office';
  const appMark = options.app === 'excel' ? 'X' : options.app === 'powerpoint' ? 'P' : 'W';
  const scripts = options.scripts
    ? `<script>${options.scripts.replace(/<\/script/gi, '<\\/script')}</script>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: cardbush-file:; font-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { --office-accent: ${options.app === 'excel' ? '#107c41' : options.app === 'powerpoint' ? '#c43e1c' : '#185abd'}; color-scheme: light; font-family: "Segoe UI Variable", "Segoe UI", "Microsoft YaHei", sans-serif; color: #242424; background: #e9e9e9; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 280px; }
    .office-chrome { position: sticky; top: 0; z-index: 20; color: #fff; background: var(--office-accent); box-shadow: 0 2px 8px rgba(0,0,0,.14); }
    .document-header { height: 42px; display: flex; align-items: center; gap: 10px; padding: 0 12px; }
    .office-mark { width: 26px; height: 26px; display: grid; place-items: center; color: var(--office-accent); background: #fff; border-radius: 2px; font-size: 15px; font-weight: 750; }
    .document-heading { min-width: 0; display: grid; gap: 1px; }
    .document-header h1 { margin: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .document-header p { margin: 0; color: rgba(255,255,255,.78); font-size: 10.5px; }
    .office-ribbon { height: 33px; display: flex; align-items: end; gap: 3px; padding: 0 9px; color: #242424; background: #fafafa; border-bottom: 1px solid #d8d8d8; }
    .office-ribbon span { height: 29px; display: inline-flex; align-items: center; padding: 0 10px; border-radius: 4px 4px 0 0; font-size: 11px; }
    .office-ribbon span.active { color: var(--office-accent); background: #fff; border-bottom: 2px solid var(--office-accent); font-weight: 650; }
    .office-ribbon em { flex: 1; }
    .office-readonly { color: #777; font-style: normal; font-size: 10px; }
    main { min-height: calc(100vh - 75px); padding: 18px; }
    .word-document, .legacy-section, .legacy-binary { max-width: 860px; margin: 0 auto; padding: 34px 42px; background: #fff; border: 1px solid #e2ded6; border-radius: 8px; box-shadow: 0 8px 26px rgba(50,43,34,.08); line-height: 1.65; }
    .word-document img { max-width: 100%; height: auto; }
    .word-document table { width: 100%; border-collapse: collapse; }
    .word-document td, .word-document th { padding: 6px 8px; border: 1px solid #d9d5cd; }
    .word-document p:first-child, .legacy-section p:first-child { margin-top: 0; }
    .legacy-section { margin-bottom: 12px; padding-top: 18px; padding-bottom: 18px; color: #6e685f; }
    .legacy-binary { display: grid; gap: 8px; }
    .legacy-binary p { margin: 0; padding-bottom: 7px; border-bottom: 1px solid #efede8; overflow-wrap: anywhere; }
    .preview-warnings { max-width: 860px; margin: 0 auto 12px; padding: 8px 12px; color: #75673e; background: #fff8df; border: 1px solid #eadca9; border-radius: 7px; font-size: 12px; }
    .docx-container { min-height: 240px; margin: -18px; overflow: auto; background: #d2d2d2; }
    .docx-container .docx-wrapper { padding: 26px 20px !important; background: #d2d2d2 !important; zoom: var(--docx-preview-scale, 1); }
    .docx-container section.docx { border: 1px solid #b9b9b9; box-shadow: 0 2px 10px rgba(0,0,0,.24) !important; }
    .office-loading { min-height: 260px; display: grid; place-items: center; color: #666; font-size: 12px; }
    .sheet-navigation { position: sticky; top: 75px; z-index: 4; display: flex; gap: 1px; margin: -18px -18px 0; padding: 4px 8px 0; overflow-x: auto; background: #f5f5f5; border-bottom: 1px solid #cfcfcf; }
    .sheet-navigation a { padding: 6px 16px 5px; color: #333; background: #e9e9e9; border: 1px solid #d0d0d0; border-bottom: 0; border-radius: 3px 3px 0 0; text-decoration: none; white-space: nowrap; font-size: 11px; }
    .sheet-navigation a:first-child { color: #107c41; background: #fff; border-top: 2px solid #107c41; }
    .workbook { display: grid; gap: 20px; }
    .worksheet { scroll-margin-top: 110px; margin: 0 -18px -18px; background: #fff; }
    .worksheet + .worksheet { margin-top: 28px; border-top: 8px solid #d7d7d7; }
    .worksheet-title { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 10px; background: #fff; border-bottom: 1px solid #ddd; }
    .worksheet h2 { margin: 0; font-size: 11.5px; font-weight: 600; }
    .excel-grid-icon { color: #107c41; font-size: 16px; }
    .excel-formula-bar { height: 30px; display: grid; grid-template-columns: 44px 1fr; align-items: center; color: #777; background: #fff; border-bottom: 1px solid #d5d5d5; font-size: 11px; }
    .excel-formula-bar span { text-align: center; font-family: Georgia,serif; font-style: italic; }
    .excel-formula-bar div { height: 22px; display: flex; align-items: center; padding: 0 8px; border-left: 1px solid #d5d5d5; }
    .table-scroll { max-height: calc(100vh - 170px); overflow: auto; background: #fff; }
    table { border-spacing: 0; border-collapse: separate; }
    .worksheet table { table-layout: fixed; min-width: 100%; }
    .worksheet th, .worksheet td { height: 20px; min-width: 24px; max-width: 420px; padding: 2px 5px; overflow: hidden; border-right: 1px solid #d9d9d9; border-bottom: 1px solid #d9d9d9; font-family: Calibri,"Microsoft YaHei",sans-serif; font-size: 11pt; text-align: left; text-overflow: ellipsis; white-space: pre; }
    .worksheet td:hover { outline: 2px solid #107c41; outline-offset: -2px; }
    .worksheet thead th { position: sticky; top: 0; z-index: 2; min-width: 44px; height: 22px; color: #555; background: #f2f2f2; text-align: center; font-size: 10px; font-weight: 400; }
    .worksheet .row-number { position: sticky; left: 0; z-index: 1; min-width: 44px; width: 44px; color: #555; background: #f2f2f2; text-align: center; font-size: 10px; font-weight: 400; }
    .worksheet thead .row-number { z-index: 3; }
    .excel-row-heading { width: 44px; }
    .limit-notice { color: #8a6a25; font-size: 11.5px; }
    .empty-sheet { color: #8a857c; font-style: italic; }
    .slide-deck { display: grid; gap: 26px; max-width: 1000px; margin: 0 auto; counter-reset: slides; }
    .slide-stage { position: relative; padding: 10px; background: #c8c8c8; border-radius: 3px; box-shadow: 0 5px 18px rgba(0,0,0,.18); }
    .slide-stage-number { position: absolute; left: -34px; top: 10px; width: 28px; color: #666; font-size: 11px; text-align: right; }
    .slide-stage-canvas { aspect-ratio: 16 / 9; overflow: hidden; background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.22); }
    .slide-stage-canvas > * { max-width: 100%; }
    .empty-state { min-height: 240px; display: grid; place-content: center; padding: 30px; color: #777168; text-align: center; }
    @media (max-width: 560px) { main { padding: 10px; } .word-document { padding: 24px 20px; } .office-ribbon span { padding: 0 6px; } .office-ribbon span:nth-of-type(n+5) { display:none; } .slide-stage-number { display:none; } }
  </style>
</head>
<body>
  <div class="office-chrome">
    <header class="document-header"><span class="office-mark">${appMark}</span><div class="document-heading"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(appName)} · ${escapeHtml(subtitle)}</p></div></header>
    <nav class="office-ribbon"><span>文件</span><span class="active">开始</span><span>插入</span><span>${options.app === 'powerpoint' ? '设计' : options.app === 'excel' ? '公式' : '布局'}</span><span>审阅</span><span>视图</span><em></em><b class="office-readonly">只读</b></nav>
  </div>
  <main>${body}</main>
  ${scripts}
</body>
</html>`;
}
