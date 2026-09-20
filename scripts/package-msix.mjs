import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureMsixSdk } from './msix-sdk.mjs';

const root = path.resolve(import.meta.dirname, '..');
const testIdentity = {
  identityName: 'CardBush.PackagingTest',
  publisher: 'CN=CardBush Packaging Test',
  publisherDisplayName: 'CardBush Packaging Test',
  displayName: 'CardBush Packaging Test',
  version: '1.0.0.0',
};

export function validateIdentity(input) {
  const result = {};
  for (const field of ['identityName', 'publisher', 'publisherDisplayName', 'displayName', 'version']) {
    const value = input?.[field];
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()
      || /REPLACE_WITH|[\x00-\x1f]|\$\{|[\ud800-\udfff]/u.test(value)) {
      throw new Error(`Invalid ${field}: copy the exact value from Partner Center; replace all example values.`);
    }
    result[field] = value;
  }
  if (!/^[a-zA-Z0-9.-]{3,50}$/.test(result.identityName)
    || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(result.identityName)) {
    throw new Error('identityName must be the 3–50 character Package/Identity/Name from Partner Center.');
  }
  if (!/^CN=.+/.test(result.publisher)) throw new Error('publisher must include the complete CN= value.');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/.test(result.version)
    || result.version.split('.').some(part => Number(part) > 65535)
    || Number(result.version.split('.')[0]) === 0) {
    throw new Error('version must be Major.Minor.Build.0, with Major >= 1 and each part <= 65535 (Store revision is zero).');
  }
  return result;
}

function xml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function createManifest(identity) {
  const value = Object.fromEntries(Object.entries(validateIdentity(identity)).map(([key, text]) => [key, xml(text)]));
  // Windows 11 honors the specific excluded key. Windows 10 uses desktop6's
  // registry-only opt-out instead. Keep filesystem virtualization enabled.
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5"
  xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
  xmlns:virtualization="http://schemas.microsoft.com/appx/manifest/virtualization/windows10"
  IgnorableNamespaces="uap uap5 desktop4 rescap desktop6 virtualization">
  <Identity Name="${value.identityName}" Publisher="${value.publisher}" Version="${value.version}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${value.displayName}</DisplayName>
    <PublisherDisplayName>${value.publisherDisplayName}</PublisherDisplayName>
    <Description>CardBush desktop AI workspace</Description>
    <Logo>assets\\StoreLogo.png</Logo>
    <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>
    <virtualization:RegistryWriteVirtualization>
      <virtualization:ExcludedKeys>
        <virtualization:ExcludedKey>HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.cardbush.browser_connector</virtualization:ExcludedKey>
      </virtualization:ExcludedKeys>
    </virtualization:RegistryWriteVirtualization>
  </Properties>
  <Resources><Resource Language="zh-CN" /><Resource Language="en-US" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.19041.0" /></Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>
  <Applications>
    <Application Id="CardBush" Executable="app\\CardBush.exe" EntryPoint="Windows.FullTrustApplication" desktop4:SupportsMultipleInstances="true">
      <uap:VisualElements DisplayName="${value.displayName}" Description="CardBush desktop AI workspace"
        BackgroundColor="transparent" Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" />
      </uap:VisualElements>
      <Extensions>
        <uap5:Extension Category="windows.appExecutionAlias" Executable="app\\resources\\chrome-native-host\\CardBushBrowserHost.exe" EntryPoint="Windows.FullTrustApplication">
          <uap5:AppExecutionAlias desktop4:Subsystem="console">
            <uap5:ExecutionAlias Alias="CardBushBrowserHost.exe" />
          </uap5:AppExecutionAlias>
        </uap5:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
`;
}

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} exited with ${result.status}: ${args[0]}`);
}

export async function verifyMsix(file, expectedManifest) {
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(await readFile(file));
  const manifest = await archive.file('AppxManifest.xml')?.async('string');
  // MakeAppx may normalize line endings, but must retain the supplied identity,
  // capabilities and executable path. It performs the schema/semantic validation.
  if (manifest?.replace(/\r\n/g, '\n') !== expectedManifest.replace(/\r\n/g, '\n')) {
    throw new Error('Packaged manifest differs from the requested Store identity/manifest.');
  }
  const required = ['AppxBlockMap.xml', '[Content_Types].xml', 'app/CardBush.exe',
    'app/resources/app.asar', 'app/resources/process-guard/current.json',
    'app/resources/chrome-native-host/CardBushBrowserHost.exe',
    'app/resources/runtime-tools/ripgrep/win32-x64/rg.exe',
    'assets/StoreLogo.png', 'assets/Square150x150Logo.png',
    'assets/Square44x44Logo.png', 'assets/Wide310x150Logo.png'];
  for (const name of required) if (!archive.file(name)) throw new Error(`MSIX is missing ${name}`);
  const hostManifest = JSON.parse(await archive.file('app/resources/process-guard/current.json').async('string'));
  if (!/^CardBushProcessHost-[a-f0-9]+\.exe$/.test(hostManifest.fileName)
    || !archive.file(`app/resources/process-guard/${hostManifest.fileName}`)) {
    throw new Error('MSIX is missing the current native process host.');
  }
  if (archive.file('AppxSignature.p7x')) throw new Error('Store upload package unexpectedly contains a local signature.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest('hex'), files: Object.keys(archive.files).length };
}

async function cachedElectronArchive() {
  if (!process.env.LOCALAPPDATA) return undefined;
  const electronPackage = path.join(root, 'node_modules', 'electron');
  const { version } = JSON.parse(await readFile(path.join(electronPackage, 'package.json'), 'utf8'));
  const name = `electron-v${version}-win32-x64.zip`;
  const checksums = JSON.parse(await readFile(path.join(electronPackage, 'checksums.json'), 'utf8'));
  if (!checksums[name]) return undefined;
  const cache = path.join(process.env.LOCALAPPDATA, 'electron', 'Cache');
  const directories = await readdir(cache, { withFileTypes: true }).catch(() => []);
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const archive = path.join(cache, directory.name, name);
    try {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(archive)) hash.update(chunk);
      if (hash.digest('hex') === checksums[name]) return archive;
    } catch { /* Missing/incomplete cache entries fall back to the builder. */ }
  }
  return undefined;
}

async function main() {
  const { values } = parseArgs({ options: {
    identity: { type: 'string', default: 'packaging/msix/identity.local.json' },
    check: { type: 'boolean' }, test: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run package:msix -- [--identity path/to/identity.json] [--check]\n'
      + 'npm run package:msix -- --test  (test identity only; NEVER upload this package)');
    return;
  }
  const identityPath = path.resolve(root, values.identity);
  let identity;
  try { identity = validateIdentity(values.test ? testIdentity : JSON.parse(await readFile(identityPath, 'utf8'))); }
  catch (error) {
    throw new Error(`MSIX identity is not ready. Copy packaging/msix/identity.example.json to identity.local.json and fill in Partner Center values.\n${error.message}`);
  }
  const manifest = createManifest(identity);
  if (values.check) { console.log('MSIX identity configuration is valid.', JSON.stringify(identity, null, 2)); return; }
  if (process.platform !== 'win32') throw new Error('Build the Windows x64 MSIX on Windows.');
  const sdk = await ensureMsixSdk(root);
  process.env.ELECTRON_BUILDER_WINDOWS_KITS_PATH = sdk.directory;
  const startedAt = new Date().toISOString();
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim();
  const workingTree = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim();
  const outputRoot = path.join(root, values.test ? 'release-msix-test' : 'release-msix');
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(path.join(outputRoot, `${identity.version}-`));
  const resources = path.join(output, 'build-resources');
  await mkdir(resources, { recursive: true });
  const manifestPath = path.join(resources, 'AppxManifest.xml');
  await writeFile(manifestPath, manifest);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this script through npm run package:msix.');
  run(process.execPath, [npmCli, 'run', 'runtime-tools:verify']);
  run(process.execPath, ['scripts/build-process-resource-host.mjs']);
  run(process.execPath, [npmCli, 'run', 'build']);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']);
  const { default: electron } = await import('electron');
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  run(electron, ['scripts/generate-msix-assets.cjs', path.join(resources, 'appx')], childEnv);

  // v26's stable AppX target calls Microsoft's MakeAppx, which supports .msix
  // output directly. This keeps the existing builder and does not rename an EXE.
  // The SDK override above supplies Microsoft's complete, verified toolset.
  const { build, Platform, Arch } = await import('electron-builder');
  for (const name of ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const artifactName = `${values.test ? 'TEST-ONLY-' : ''}CardBush-${identity.version}-x64.msix`;
  await build({
    projectDir: root, publish: 'never', targets: Platform.WINDOWS.createTarget(['appx'], Arch.x64),
    config: {
      extends: path.join(root, 'electron-builder.yml'),
      // Reuse only the original archive verified with Electron's checksums.
      // The development runtime directory can contain extra branded executables.
      electronDist: await cachedElectronArchive(),
      directories: { output, buildResources: resources },
      toolsets: { winCodeSign: '1.1.0' },
      win: { icon: path.join(root, 'assets/cardbush.ico'), signExecutable: false },
      appx: {
        artifactName, identityName: identity.identityName, publisher: identity.publisher,
        publisherDisplayName: identity.publisherDisplayName, displayName: identity.displayName,
        applicationId: 'CardBush', customManifestPath: manifestPath,
        languages: ['zh-CN', 'en-US'], setBuildNumber: false,
      },
    },
  });
  const file = path.join(output, artifactName);
  const verification = await verifyMsix(file, manifest);
  await writeFile(path.join(output, 'SHA256SUMS.txt'), `${verification.sha256}  ${artifactName}\n`);
  const extracted = path.join(output, 'extracted-msix');
  run(sdk.executable, ['unpack', '/p', file, '/d', extracted]);
  run(process.execPath, ['scripts/verify-packaged-platform.mjs', path.join(extracted, 'app')], {
    ...process.env, CARDBUSH_SMOKE_REPORT: path.join(output, 'packaged-smoke-report.json'),
  });
  await writeFile(path.join(output, 'msix-build-report.json'), JSON.stringify({
    testOnly: Boolean(values.test), artifact: file, identity, ...verification,
    startedAt, completedAt: new Date().toISOString(),
    source: { commit, modifiedWorkingTree: Boolean(workingTree), appVersion: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version },
    sdk: { version: sdk.version, archiveSha256: sdk.archiveSha256, archiveUrl: sdk.archiveUrl },
    verified: ['TypeScript and production build', 'MakeAppx validation', 'package contents and identity',
      'MakeAppx extraction', 'extracted application smoke', 'native Windows icons', 'Chrome native host protocol'],
    pending: ['installed MSIX launch and tools', 'Chrome native messaging registration',
      'notifications and taskbar identity', 'Windows App Certification Kit', 'Store certification'],
  }, null, 2) + '\n');
  console.log(`${values.test ? 'TEST ONLY — DO NOT UPLOAD: ' : 'Store upload package: '}${file}`);
  console.log('The package was not installed, signed locally, uploaded, or submitted. Installed-MSIX validation remains required.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
}
