/** Map a contained preview to original desktop pixels, rejecting letterbox margins. */
export function desktopPoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, image: { width: number; height: number }) {
  const scale = Math.min(rect.width / image.width, rect.height / image.height);
  if (!(scale > 0)) return null;
  const px = (x - rect.left - (rect.width - image.width * scale) / 2) / scale;
  const py = (y - rect.top - (rect.height - image.height * scale) / 2) / scale;
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return null;
  return { x: Math.floor(px), y: Math.floor(py) };
}
