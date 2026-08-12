const path = require('node:path');
const fs = require('node:fs/promises');

const { app, BrowserWindow } = require('electron');

const { renderOfficePreview } = require('../dist-electron/officePreview.js');

const targets = process.argv.slice(2).map((value) => path.resolve(value));

app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  if (targets.length === 0) {
    throw new Error('Pass one or more .docx, .xlsx, or .pptx paths.');
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
        const viewTab = document.querySelector('[data-ribbon-tab="view"]');
        viewTab?.click();
        const visiblePanel = document.querySelector('[data-ribbon-panel]:not([hidden])');
        const slideCanvas = document.querySelector('.slide-stage-canvas');
        return {
          activeSheet: document.querySelector('[data-sheet-index].active')?.textContent?.trim() || '',
          visibleSheetCount: visibleSheets.length,
          activeRibbon: document.querySelector('[data-ribbon-tab].active')?.dataset.ribbonTab || '',
          visibleRibbonPanel: visiblePanel?.dataset.ribbonPanel || '',
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          slideCanvasFits: !slideCanvas || slideCanvas.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
        };
      })()
    `, true);
    console.log(JSON.stringify({ target, ...result }));
    window.destroy();
  }
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
