import fs from 'node:fs';

/** Shell APIs bypass Electron's ASAR filesystem, so they need a real native file. */
export function windowsShellIconPath({ packaged, executablePath, candidates, exists = fs.existsSync }: {
  packaged: boolean;
  executablePath: string;
  candidates: readonly string[];
  exists?: (filePath: string) => boolean;
}) {
  const paths = packaged ? [executablePath, ...candidates] : [...candidates, executablePath];
  return paths.find(filePath => !/(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(filePath) && exists(filePath));
}
