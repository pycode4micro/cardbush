import type { WebContents } from 'electron';

export type InspectorRegionCapture = { guestId?: number; rect: { x: number; y: number; width: number; height: number } };

/** Crop only the explicitly selected viewport region; coordinates are zoom independent. */
export async function captureInspectorRegion(owner: WebContents, input: InspectorRegionCapture, resolveGuest: (id: number) => WebContents) {
  const r = input?.rect;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0 || r.x < -.01 || r.y < -.01 || r.x + r.width > 1.01 || r.y + r.height > 1.01) throw Error('Invalid preview region.');
  const target = input.guestId === undefined ? owner : resolveGuest(input.guestId);
  const image = await target.capturePage();
  if (image.isEmpty()) throw Error('页面尚未绘制，请稍后重新框选。');
  const size = image.getSize(), x = Math.max(0, Math.floor(r.x * size.width)), y = Math.max(0, Math.floor(r.y * size.height));
  const width = Math.min(size.width - x, Math.ceil(r.width * size.width)), height = Math.min(size.height - y, Math.ceil(r.height * size.height));
  if (width < 1 || height < 1) throw Error('The selected region is outside the preview.');
  let cropped = image.crop({ x, y, width, height });
  if (Math.max(width, height) > 1800) cropped = cropped.resize(width >= height ? { width: 1800 } : { height: 1800 });
  return cropped.toDataURL();
}
