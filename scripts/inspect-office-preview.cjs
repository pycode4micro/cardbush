const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const JSZip = require('jszip');

const { app, BrowserWindow } = require('electron');

const { renderOfficePreview } = require('../dist-electron/officePreview.js');

const requestedTargets = process.argv.slice(2);
const selfTest = requestedTargets.includes('--self-test');
let targets = requestedTargets.filter((value) => value !== '--self-test').map((value) => path.resolve(value));
let selfTestRoot = '';

app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  if (selfTest) {
    selfTestRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cardbush-office-preview-'));
    targets = await createSelfTestDocuments(selfTestRoot);
  }
  if (targets.length === 0) {
    throw new Error('Pass one or more .docx, .xlsx, or .pptx paths, or use --self-test.');
  }
  for (const target of targets) {
    const html = await renderOfficePreview(target);
    const window = new BrowserWindow({
      width: 720,
      height: 760,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    const result = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const deadline = Date.now() + 20000;
        const inspect = () => {
          const docxPages = document.querySelectorAll('.docx-wrapper section.docx').length;
          const pptxSlides = document.querySelectorAll('.slide-stage-canvas .slide').length;
          const spreadsheetCells = document.querySelectorAll('.worksheet td').length;
          const error = document.querySelector('.empty-state');
          if (docxPages || pptxSlides || spreadsheetCells || error || Date.now() >= deadline) {
            resolve({
              docxPages,
              pptxSlides,
              spreadsheetCells,
              text: document.body.innerText.slice(0, 500),
              error: error && error.innerText,
            });
            return;
          }
          setTimeout(inspect, 80);
        };
        inspect();
      })
    `, true);
    const screenshotDir = process.env.CARDBUSH_OFFICE_SCREENSHOT_DIR;
    if (screenshotDir) {
      await fs.mkdir(screenshotDir, { recursive: true });
      const screenshotPath = path.join(
        screenshotDir,
        `${path.basename(target).replace(/[^a-z0-9._-]+/gi, '_')}.png`,
      );
      await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
      result.screenshotPath = screenshotPath;
    }
    result.interactions = await window.webContents.executeJavaScript(`
      (() => {
        const sheetTabs = [...document.querySelectorAll('[data-sheet-index]')];
        if (sheetTabs.length > 1) sheetTabs[1].click();
        const visibleSheets = [...document.querySelectorAll('[data-sheet]')]
          .filter((sheet) => !sheet.hidden);
        const zoomIn = document.querySelector('[data-action="zoom-in"]');
        zoomIn?.click();
        const slideCanvas = document.querySelector('.slide-stage-canvas');
        const mutatingControls = [...document.querySelectorAll('button, input, textarea, [contenteditable]')]
          .filter((node) => /(?:edit|save|insert|delete|write|编辑|保存|插入|删除)/i.test(
            [node.textContent, node.getAttribute('data-action'), node.getAttribute('aria-label')]
              .filter(Boolean)
              .join(' '),
          ));
        return {
          activeSheet: document.querySelector('[data-sheet-index].active')?.textContent?.trim() || '',
          visibleSheetCount: visibleSheets.length,
          hasReaderToolbar: Boolean(document.querySelector('.office-reader-toolbar')),
          readonlyBadge: document.querySelector('.readonly-badge')?.textContent?.trim() || '',
          zoomValue: document.querySelector('[data-zoom-value]')?.textContent?.trim() || '',
          mutatingControlCount: mutatingControls.length,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          slideCanvasFits: !slideCanvas || slideCanvas.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
        };
      })()
    `, true);
    console.log(JSON.stringify({ target, ...result }));
    window.destroy();
  }
  if (selfTestRoot) await fs.rm(selfTestRoot, { recursive: true, force: true });
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

async function createSelfTestDocuments(root) {
  const docxPath = path.join(root, 'reading-sample.docx');
  const docx = new JSZip();
  docx.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  docx.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  docx.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>CardBush Office 只读阅读体验</w:t></w:r></w:p>
        <w:p><w:r><w:t>保留页面、字体和段落结构，不提供编辑或保存能力。</w:t></w:r></w:p>
        <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
      </w:body>
    </w:document>`);
  await fs.writeFile(docxPath, await docx.generateAsync({ type: 'nodebuffer' }));

  const xlsxPath = path.join(root, 'reading-sample.xlsx');
  const xlsx = new JSZip();
  xlsx.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`);
  xlsx.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`);
  xlsx.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="阅读数据" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`);
  xlsx.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`);
  xlsx.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>项目</t></is></c><c r="B1" t="inlineStr"><is><t>状态</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Office 预览</t></is></c><c r="B2" t="inlineStr"><is><t>只读</t></is></c></row></sheetData>
    </worksheet>`);
  await fs.writeFile(xlsxPath, await xlsx.generateAsync({ type: 'nodebuffer' }));

  const pptPath = path.join(root, 'reading-sample.ppt');
  await fs.writeFile(pptPath, Buffer.from('CardBush Office read-only slide preview\nPage 1\nNo editing or saving controls.'));
  return [docxPath, xlsxPath, pptPath];
}
