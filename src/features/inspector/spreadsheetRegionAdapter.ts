import type { RegionRect } from './regionSelection';

type VisibleCell = { column: { key: string }; rowIndex: number; colspan: number; rowspan: number; drawX: number; drawY: number; visibleWidth: number; visibleHeight: number; value: unknown };
type Grid = { ctx: { canvasElement: HTMLCanvasElement; stageWidth: number; stageHeight: number; scrollX: number; scrollY: number; header: { height: number }; body: { renderRows: { data: { __s: number }; cells: VisibleCell[] }[] } }; scrollTo: (x: number, y: number) => void };
export type RegionGrid = HTMLElement & {
  cardbushRegionCells?: () => { rect: RegionRect; text: string; cell: string; sheet: string }[];
  cardbushRegionScroll?: (x: number, y: number) => void;
};

/** Visible geometry only; no workbook data or edit access is exposed to the host. */
export function exposeSpreadsheetRegions(root: RegionGrid, table: Grid, sheetName: () => string) {
  root.dataset.regionGrid = '';
  root.cardbushRegionScroll = (x, y) => table.scrollTo(Math.max(0, table.ctx.scrollX + x), Math.max(0, table.ctx.scrollY + y));
  root.cardbushRegionCells = () => {
    const ctx = table.ctx, canvas = ctx.canvasElement.getBoundingClientRect();
    const sx = canvas.width / ctx.stageWidth, sy = canvas.height / ctx.stageHeight;
    const rowHeaderWidth = ctx.body.renderRows[0]?.cells.find(cell => cell.column.key === '__index')?.visibleWidth ?? 0;
    const letter = (index: number) => { let result = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; };
    return ctx.body.renderRows.filter(row => row.data.__s === 2).flatMap(row => row.cells.filter(cell => /^c\d+$/.test(cell.column.key) && cell.rowspan > 0 && cell.colspan > 0).map(cell => {
      const x = Math.max(rowHeaderWidth, cell.drawX), y = Math.max(ctx.header.height, cell.drawY);
      return { rect: { x: canvas.x + x * sx, y: canvas.y + y * sy,
        width: Math.max(0, Math.min(ctx.stageWidth, cell.drawX + cell.visibleWidth) - x) * sx,
        height: Math.max(0, Math.min(ctx.stageHeight, cell.drawY + cell.visibleHeight) - y) * sy },
      cell: letter(Number(cell.column.key.slice(1))) + (cell.rowIndex + 1), text: String(cell.value ?? '').slice(0, 2000), sheet: sheetName() };
    })).filter(cell => cell.rect.width > 0 && cell.rect.height > 0);
  };
}
