import path from 'node:path';

/** Adapter for the pinned @file-viewer/renderer-spreadsheet 3.0.0 canvas renderer. */
export function spreadsheetRegionPlugin(rootDir) {
  return {
    name: 'cardbush-spreadsheet-region', enforce: 'pre',
    transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/@file-viewer/renderer-spreadsheet/dist/spreadsheet.js')) return;
      const marker = 'enableEVirtTableShadowEventTargeting(table.ctx);';
      if (source.split(marker).length !== 2) throw Error('Spreadsheet region adapter needs review after renderer upgrade.');
      const adapter = path.join(rootDir, 'src/features/inspector/spreadsheetRegionAdapter.ts').replaceAll('\\', '/');
      return { code: `import { exposeSpreadsheetRegions } from ${JSON.stringify(adapter)};\n` + source.replace(marker, marker + '\nexposeSpreadsheetRegions(root, table, () => sheetTabsBar.querySelector(".sheet-tab.active")?.textContent || "");'), map: null };
    },
  };
}
