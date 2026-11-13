import { nativeImage, type NativeImage } from 'electron';
import { join } from 'node:path';

let atlas: NativeImage | undefined;
let last: { index: number; image: NativeImage } | undefined;

/** Windows expects a raster overlay; null removes it from the taskbar button. */
export function taskbarBadge(appPath: string, count: number): NativeImage | null {
  if (!Number.isSafeInteger(count) || count < 1) return null;
  const index = Math.min(count, 100) - 1;
  if (last?.index === index) return last.image;
  atlas ??= nativeImage.createFromPath(join(appPath, 'assets', 'tray', 'unread-badges.png'));
  const size = atlas.getSize().width / 10;
  if (!size) return null;
  const image = atlas.crop({ x: index % 10 * size, y: Math.floor(index / 10) * size, width: size, height: size });
  last = { index, image };
  return image;
}
