const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const JSZip = require('jszip');
const XLSX = require('styled-exceljs');

const { app, BrowserWindow, protocol } = require('electron');

const { renderOfficePreview } = require('../dist-electron/officePreview.js');

const previewScheme = 'cardbush-file';
const requestedTargets = process.argv.slice(2);
const selfTest = requestedTargets.includes('--self-test');
let targets = requestedTargets.filter((value) => value !== '--self-test').map((value) => path.resolve(value));
let selfTestRoot = '';

protocol.registerSchemesAsPrivileged([
  {
    scheme: previewScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  registerPreviewProtocol();
  if (selfTest) {
    selfTestRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cardbush-office-preview-'));
    targets = await createSelfTestDocuments(selfTestRoot);
  }
  if (targets.length === 0) {
    throw new Error('Pass one or more .docx, .xlsx, or .pptx paths, or use --self-test.');
  }
  for (const target of targets) {
    const extension = path.extname(target).toLowerCase();
    const highFidelity = extension === '.xlsx' || extension === '.pptx' || extension === '.ppt';
    const screenshotDir = process.env.CARDBUSH_OFFICE_SCREENSHOT_DIR;
    const window = new BrowserWindow({
      width: 980,
      height: 760,
      show: Boolean(screenshotDir),
      skipTaskbar: Boolean(screenshotDir),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    if (highFidelity) {
      await window.loadURL(
        `${previewScheme}://office-preview/?path=${encodeURIComponent(target)}`,
      );
    } else {
      const html = await renderOfficePreview(target);
      await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    }
    const result = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const deadline = Date.now() + 60000;
        const inspect = () => {
          const docxPages = document.querySelectorAll('.docx-wrapper section.docx').length;
          const pptxSlides = document.querySelectorAll('.pptx-viewer-shell [data-slide-index], .pptx-viewer-shell .slide').length;
          const binaryPptSlides = document.querySelectorAll('.ppt-binary-page').length;
          const spreadsheetRoot = document.querySelector('.excel-wrapper[data-file-viewer-spreadsheet-root]');
          const spreadsheetCells = document.querySelectorAll('.worksheet td').length;
          const richPreviewReady = Boolean(
            (spreadsheetRoot || pptxSlides || binaryPptSlides) &&
            document.querySelector('.office-preview-progress')?.hidden
          );
          const error = document.querySelector('.office-preview-error:not([hidden]), .empty-state');
          if (docxPages || richPreviewReady || spreadsheetCells || error || Date.now() >= deadline) {
            resolve({
              docxPages,
              pptxSlides,
              binaryPptSlides,
              spreadsheetCells,
              hasSpreadsheetRoot: Boolean(spreadsheetRoot),
              sheetTabs: document.querySelectorAll('.excel-wrapper .sheet-tab').length,
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
    if (screenshotDir) {
      await window.webContents.executeJavaScript(`
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      `, true);
      window.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 350));
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
        const sheetTabs = [...document.querySelectorAll('.excel-wrapper .sheet-tab, [data-sheet-index]')];
        if (sheetTabs.length > 1) sheetTabs[1].click();
        const zoomIn = document.querySelector('[data-office-action="zoom-in"], [data-action="zoom-in"]');
        zoomIn?.click();
        const mutatingControls = [...document.querySelectorAll('button, input, textarea, [contenteditable]')]
          .filter((node) => /(?:edit|save|insert|delete|write|编辑|保存|插入|删除)/i.test(
            [node.textContent, node.getAttribute('data-action'), node.getAttribute('data-office-action'), node.getAttribute('aria-label')]
              .filter(Boolean)
              .join(' '),
          ));
        return {
          activeSheet: document.querySelector('.excel-wrapper .sheet-tab.active, [data-sheet-index].active')?.textContent?.trim() || '',
          hasReaderToolbar: Boolean(document.querySelector('.office-preview-toolbar, .office-reader-toolbar')),
          readonlyBadge: document.querySelector('.office-preview-readonly, .readonly-badge')?.textContent?.trim() || '',
          zoomValue: document.querySelector('[data-office-action="zoom-reset"], [data-zoom-value]')?.textContent?.trim() || '',
          mutatingControlCount: mutatingControls.length,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          compatibilityFallback: Boolean(document.querySelector('[data-office-action="compat"]')),
        };
      })()
    `, true);
    if (selfTest) assertSelfTestResult(target, result);
    console.log(JSON.stringify({ target, ...result }));
    window.destroy();
  }
  if (selfTestRoot) await fs.rm(selfTestRoot, { recursive: true, force: true });
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

function registerPreviewProtocol() {
  protocol.handle(previewScheme, async (request) => {
    const parsed = new URL(request.url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'office-source') {
      const sourcePath = path.resolve(parsed.searchParams.get('path') || '');
      if (!['.xlsx', '.pptx', '.ppt'].includes(path.extname(sourcePath).toLowerCase())) {
        return new Response('Not found', { status: 404 });
      }
      const bytes = await fs.readFile(sourcePath);
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': contentType(sourcePath),
          'cache-control': 'no-store',
        },
      });
    }
    if (host !== 'office-preview') {
      return new Response('Not found', { status: 404 });
    }
    const relativePath = parsed.pathname.startsWith('/assets/')
      ? decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
      : 'office-preview.html';
    const distRoot = path.resolve(__dirname, '..', 'dist');
    const assetPath = path.resolve(distRoot, relativePath);
    const relative = path.relative(distRoot, assetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Not found', { status: 404 });
    }
    const bytes = await fs.readFile(assetPath);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': contentType(assetPath),
        'cache-control': relativePath === 'office-preview.html'
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
      },
    });
  });
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (extension === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (extension === '.ppt') return 'application/vnd.ms-powerpoint';
  if (extension === '.wasm') return 'application/wasm';
  if (extension === '.otf') return 'font/otf';
  return 'application/octet-stream';
}

function assertSelfTestResult(target, result) {
  const name = path.basename(target);
  if (name === 'reading-sample.docx' && result.docxPages < 1) {
    throw new Error('DOCX self-test did not render a page.');
  }
  if (
    name === 'reading-sample.xlsx' &&
    (!result.hasSpreadsheetRoot || result.sheetTabs < 2)
  ) {
    throw new Error('XLSX self-test did not render the complete workbook.');
  }
  if (name === 'reading-sample.pptx' && result.pptxSlides < 1) {
    throw new Error('PPTX self-test did not render a slide.');
  }
  if (name === 'invalid-sample.pptx' && !result.error) {
    throw new Error('Invalid PPTX did not expose the compatibility fallback.');
  }
  if (name === 'invalid-sample.ppt' && !result.error) {
    throw new Error('Invalid PPT did not expose the compatibility fallback.');
  }
  if (result.interactions.mutatingControlCount !== 0) {
    throw new Error(`${name} exposed a mutating control in read-only preview.`);
  }
}

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
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['CardBush 完整工作簿预览', '', ''],
    ['项目', '状态', '进度'],
    ['样式与合并单元格', '已还原', 100],
    ['工作表、行列尺寸和数值格式', '已还原', 100],
  ]);
  worksheet.A1.s = {
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 14 },
    fill: { patternType: 'solid', fgColor: { rgb: '107C41' } },
    alignment: { horizontal: 'center', vertical: 'center' },
  };
  worksheet['!merges'] = [XLSX.utils.decode_range('A1:C1')];
  worksheet['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 12 }];
  worksheet['!rows'] = [{ hpt: 30 }];
  const validationSheet = XLSX.utils.aoa_to_sheet([
    ['检查项', '结果'],
    ['工作表切换', '通过'],
    ['缩放与适应窗口', '通过'],
  ]);
  validationSheet['!cols'] = [{ wch: 24 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(workbook, worksheet, '阅读数据');
  XLSX.utils.book_append_sheet(workbook, validationSheet, '校验结果');
  XLSX.writeFile(workbook, xlsxPath, { bookType: 'xlsx', cellStyles: true });

  const pptxPath = path.join(root, 'reading-sample.pptx');
  const pptx = new JSZip();
  pptx.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
      <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
    </Types>`);
  pptx.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
    </Relationships>`);
  pptx.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
      <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/>
    </p:presentation>`);
  pptx.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
    </Relationships>`);
  pptx.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:cSld><p:spTree>
        <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="914400" y="1219200"/><a:ext cx="10363200" cy="2133600"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="1F6F50"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>
          <p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="3000" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Aptos Display"/></a:rPr><a:t>CardBush 完整幻灯片预览</a:t></a:r><a:endParaRPr lang="zh-CN" sz="3000"/></a:p></p:txBody>
        </p:sp>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="3" name="说明"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="1524000" y="4114800"/><a:ext cx="9144000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
          <p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="1800"><a:solidFill><a:srgbClr val="2F3A45"/></a:solidFill></a:rPr><a:t>主题、形状、文字与幻灯片比例均由原文件还原</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
    </p:sld>`);
  await fs.writeFile(pptxPath, await pptx.generateAsync({ type: 'nodebuffer' }));

  const invalidXlsxPath = path.join(root, 'invalid-sample.xlsx');
  const invalidPptxPath = path.join(root, 'invalid-sample.pptx');
  const invalidPptPath = path.join(root, 'invalid-sample.ppt');
  await fs.writeFile(invalidXlsxPath, Buffer.from('not an OpenXML workbook'));
  await fs.writeFile(invalidPptxPath, Buffer.from('not an OpenXML presentation'));
  await fs.writeFile(invalidPptPath, Buffer.from('not a PowerPoint compound document'));

  return [docxPath, xlsxPath, pptxPath, invalidXlsxPath, invalidPptxPath, invalidPptPath];
}
