import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Official Microsoft NuGet package; do not depend on the incomplete SDK
// redistribution bundled with electron-builder's win-codesign toolset.
export const sdkVersion = '10.0.26100.9169';
export const sdkSha256 = '6000c971fc9155052a8359779b30b6682c39e091664d83b3852c4702ab6d238e';
const archiveName = `microsoft.windows.sdk.buildtools.${sdkVersion}.nupkg`;
const archiveUrl = `https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/${sdkVersion}/${archiveName}`;

export function verifySdkArchive(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== sdkSha256) {
    throw new Error('Microsoft Windows SDK archive SHA-256 mismatch.');
  }
}

export async function ensureMsixSdk(root) {
  const cache = path.join(root, 'tmp', 'msix-sdk');
  await mkdir(cache, { recursive: true });
  const archivePath = path.join(cache, archiveName);
  let archive;
  try { archive = await readFile(archivePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log(`Downloading Microsoft Windows SDK BuildTools ${sdkVersion} from NuGet.`);
    const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Windows SDK download: HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 80 * 1024 * 1024) throw new Error('Windows SDK archive exceeds size limit.');
      chunks.push(chunk);
    }
    archive = Buffer.concat(chunks);
    verifySdkArchive(archive);
    await writeFile(archivePath, archive);
  }
  verifySdkArchive(archive);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(archive);
  const prefix = 'bin/10.0.26100.0/x64/';
  const directory = path.join(cache, sdkVersion, ...prefix.split('/'));
  // Restore the complete x64 tool directory, including side-by-side manifests
  // and localized resources. Each run verifies the archive before extraction.
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.startsWith(prefix)) continue;
    const relative = entry.name.slice(prefix.length);
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) {
      throw new Error(`Unexpected Windows SDK path: ${entry.name}`);
    }
    const target = path.join(directory, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.async('nodebuffer'));
  }
  const executable = path.join(directory, 'makeappx.exe');
  const probe = spawnSync(executable, ['/?'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  // MakeAppx returns 1 for help even when it starts successfully.
  if (probe.error || ![0, 1].includes(probe.status) || !probe.stdout.includes(sdkVersion)) {
    throw new Error(`Microsoft MakeAppx could not start: ${probe.error?.message || probe.stderr || probe.stdout}`);
  }
  console.log(`Microsoft MakeAppx ${sdkVersion} verified and ready.`);
  return { directory, executable, version: sdkVersion, archiveSha256: sdkSha256, archiveUrl };
}
