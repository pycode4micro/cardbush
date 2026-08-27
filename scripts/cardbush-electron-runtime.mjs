import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as ResEdit from 'resedit';

const developmentExecutablePrefix = 'cardbush-dev-';

export function resolveCardbushElectronExecutable(projectRoot) {
  const electronDist = path.join(projectRoot, 'node_modules', 'electron', 'dist');
  const electronExecutable = process.platform === 'win32'
    ? path.join(electronDist, 'electron.exe')
    : path.join(projectRoot, 'node_modules', '.bin', 'electron');
  if (process.platform !== 'win32') {
    return electronExecutable;
  }

  const iconPath = path.join(projectRoot, 'assets', 'cardbush.ico');
  if (!fs.existsSync(electronExecutable)) {
    throw new Error(`Electron executable not found: ${electronExecutable}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`CardBush icon not found: ${iconPath}`);
  }

  const electronVersion = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim();
  const electronStat = fs.statSync(electronExecutable);
  const iconData = fs.readFileSync(iconPath);
  const identity = createHash('sha256')
    .update(electronVersion)
    .update(String(electronStat.size))
    .update(String(electronStat.mtimeMs))
    .update(iconData)
    .digest('hex')
    .slice(0, 12);
  const targetExecutable = path.join(
    electronDist,
    `${developmentExecutablePrefix}${identity}.exe`,
  );
  if (!fs.existsSync(targetExecutable)) {
    writeBrandedElectronExecutable(electronExecutable, targetExecutable, iconData);
  }
  removeStaleDevelopmentExecutables(electronDist, targetExecutable);
  return targetExecutable;
}

function writeBrandedElectronExecutable(sourcePath, targetPath, iconData) {
  const source = fs.readFileSync(sourcePath);
  const executable = ResEdit.NtExecutable.from(source, { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);
  const iconFile = ResEdit.Data.IconFile.from(iconData);
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const targetGroups = iconGroups.length > 0
    ? iconGroups
    : [{ id: 1, lang: 1033 }];
  for (const group of targetGroups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      group.id,
      group.lang,
      iconFile.icons.map((item) => item.data),
    );
  }

  for (const versionInfo of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)) {
    versionInfo.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        FileDescription: 'CardBush desktop',
        InternalName: 'cardbush',
        OriginalFilename: path.basename(targetPath),
        ProductName: 'CardBush',
      },
    );
    versionInfo.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);

  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, Buffer.from(executable.generate()));
  fs.renameSync(temporaryPath, targetPath);
}

function removeStaleDevelopmentExecutables(electronDist, activeExecutable) {
  for (const name of fs.readdirSync(electronDist)) {
    if (
      !name.startsWith(developmentExecutablePrefix) ||
      !name.endsWith('.exe') ||
      path.join(electronDist, name) === activeExecutable
    ) {
      continue;
    }
    try {
      fs.rmSync(path.join(electronDist, name), { force: true });
    } catch {
      // A previous development executable may still be in use. It can be
      // cleaned on a later launch without blocking the current application.
    }
  }
}
