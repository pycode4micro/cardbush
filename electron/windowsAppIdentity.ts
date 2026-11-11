import fs from 'node:fs';

/** Shell APIs bypass Electron's ASAR filesystem, so they need a real native file. */
export function windowsShellIconPath({ packaged, executablePath, candidates, exists = fs.existsSync }: {
  packaged: boolean;
  executablePath: string;
  candidates: readonly string[];
  exists?: (filePath: string) => boolean;
}) {
  // Explorer caches icons by path and index. Our development launcher embeds the
  // icon in an EXE whose name changes with its bytes; the source ICO path is stable.
  const branded = /(?:^|[\\/])cardbush-dev-[a-f0-9]+\.exe$/i.test(executablePath);
  const paths = packaged || branded ? [executablePath, ...candidates] : [...candidates, executablePath];
  return paths.find(filePath => !/(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(filePath) && exists(filePath));
}
