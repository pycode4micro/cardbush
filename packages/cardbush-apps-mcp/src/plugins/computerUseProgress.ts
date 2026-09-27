export type ProgressBounds = { x: number; y: number; width: number; height: number };
export type ProgressEvidence = {
  /** Discovery and screenshots never replace a target window's baseline. */
  source: 'window' | 'discovery' | 'desktop';
  target?: string;
  bounds?: ProgressBounds;
  focusedBounds?: ProgressBounds;
  focusedFingerprint?: string;
  foreground?: boolean;
  consistent?: boolean;
  explicit?: boolean;
  relatedTransition?: boolean;
};

/** Compare detail near the action as well as broad changes. A blinking caret
 * alone is too small to count; a changed word must not disappear into the
 * average brightness of a large application window. */
export function hasVisualProgress(left: string, right: string, bounds?: ProgressBounds, region?: ProgressBounds): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left, 'base64'), b = Buffer.from(right, 'base64');
  if (!a.length || a.length !== b.length) return false;
  const side = Math.sqrt(a.length);
  if (!Number.isInteger(side)) return false;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
  if (total / a.length > 6) return true;
  // Detailed production signatures use 128x128 pixels. Coarse
  // samples do not contain enough evidence to infer local text changes.
  if (side < 64) return false;
  const roi = region && bounds ? {
    left: Math.max(0, Math.floor(region.x / bounds.width * side)),
    top: Math.max(0, Math.floor(region.y / bounds.height * side)),
    right: Math.min(side, Math.ceil((region.x + region.width) / bounds.width * side)),
    bottom: Math.min(side, Math.ceil((region.y + region.height) / bounds.height * side)),
  } : { left: 0, top: 0, right: side, bottom: side };
  // Local tiles tolerate sampling noise; they need multiple changed pixels,
  // not a one-pixel cursor flash or a single altered sample.
  for (let y = roi.top; y < roi.bottom; y += 8) for (let x = roi.left; x < roi.right; x += 8) {
    let difference = 0, significant = 0;
    for (let dy = 0; dy < 8 && y + dy < roi.bottom; dy++) for (let dx = 0; dx < 8 && x + dx < roi.right; dx++) {
      const i = (y + dy) * side + x + dx, value = Math.abs(a[i]! - b[i]!);
      difference += value;
      if (value >= 10) significant++;
    }
    if (difference >= 240 && significant >= 12) return true;
  }
  return false;
}

/** Compiled inside the capture process; avoids thousands of PowerShell pixel
 * calls while preserving small text changes in a bounded internal signature. */
export const computerUseVisualProgressScript = String.raw`
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
public static class CardBushVisualProgress {
  public static byte[] Read(Bitmap image) {
    using(var sample=new Bitmap(128,128)) using(var graphics=Graphics.FromImage(sample)) {
      graphics.InterpolationMode=InterpolationMode.Low;
      graphics.DrawImage(image,0,0,128,128);
      var result=new byte[128*128];
      for(int y=0;y<128;y++) for(int x=0;x<128;x++) {
        Color pixel=sample.GetPixel(x,y);
        result[y*128+x]=(byte)Math.Round(pixel.R*0.299+pixel.G*0.587+pixel.B*0.114);
      }
      return result;
    }
  }
}
'@
`;
