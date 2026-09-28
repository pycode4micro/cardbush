import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from 'app-builder-lib/out/util/config/config.js';
import { validateIdentity } from './package-msix.mjs';

export function signingReadiness(config, env = process.env) {
  const win = config.win ?? {};
  const options = win.signtoolOptions ?? {};
  if (win.forceCodeSigning !== true || win.signExecutable === false || win.signAndEditExecutable === false) {
    throw Error('Public Windows releases must enable forceCodeSigning and executable signing.');
  }
  // Report configuration state only: never print certificate bytes or passwords.
  const configured = Boolean(env.WIN_CSC_LINK?.trim() || env.CSC_LINK?.trim()
    || options.certificateFile || options.certificateSha1 || options.certificateSubjectName
    || options.sign || win.azureSignOptions);
  if (!configured) throw Error('Windows release signing is not configured. Set WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD in the private build environment, or configure a certificate-store/cloud signing provider in electron-builder.release.yml. No public EXE was built. Do not use a self-signed development certificate for public distribution.');
  return { configured: true, verified: false };
}

export async function checkWindowsRelease(root, channel, env = process.env) {
  if (channel === 'exe') {
    const config = await getConfig(root, 'electron-builder.release.yml');
    return { channel, ...signingReadiness(config, env), pending: ['Trusted publisher identity, timestamp and actual output signatures'] };
  }
  if (channel !== 'store-msix') throw Error('Choose --channel exe or --channel store-msix.');
  const file = path.join(root, 'packaging/msix/identity.local.json');
  if (!fs.existsSync(file)) throw Error('Store identity is missing: fill packaging/msix/identity.local.json from Partner Center.');
  const identity = validateIdentity(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (identity.identityName === 'CardBush.PackagingTest') throw Error('A test identity cannot be used for a Store release.');
  return { channel, configured: true, verified: false, version: identity.version,
    pending: ['Partner Center identity confirmation', 'Microsoft Store signing and certification', 'Installed package verification with Smart App Control enabled'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const channel = process.argv[process.argv.indexOf('--channel') + 1];
  checkWindowsRelease(path.resolve(import.meta.dirname, '..'), channel)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
