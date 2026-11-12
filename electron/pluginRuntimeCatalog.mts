import type { PluginRuntime } from '@cardbush/platform';

const nodeDist = 'https://nodejs.org/dist';
const pythonReleases = 'https://github.com/astral-sh/python-build-standalone/releases';
export type RuntimeBuild = {version: string; url: string; digest: string; directory: string};
type Fetcher = typeof fetch;

async function readCatalog(url: string, request: Fetcher) {
  const response = await request(url, {signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw Error(`Runtime catalog request failed (HTTP ${response.status}).`);
  return response.text();
}

function compare(left: string, right: string) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}
function matches(version: string, selector: string) {
  return version === selector || version.startsWith(selector + '.');
}
function sums(value: string) {
  return value.split(/\r?\n/).flatMap(line => {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line);
    return match ? [{name: match[2], digest: match[1]}] : [];
  });
}

export async function resolveRuntimeBuild(kind: PluginRuntime, selector: string, request: Fetcher = fetch): Promise<RuntimeBuild> {
  if (!/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(selector)) throw Error('Use a numeric runtime version, for example 24 or 3.12.');
  const {platform, arch} = process;
  if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw Error('No managed runtime build for this platform.');
  if (platform === 'linux' && !(process.report?.getReport() as {header?: {glibcVersionRuntime?: string}})?.header?.glibcVersionRuntime) {
    throw Error('Managed Linux runtimes require glibc on this platform.');
  }
  if (kind === 'node') {
    const index: {version: string; files: string[]}[] = JSON.parse(await readCatalog(nodeDist + '/index.json', request));
    const fileType = platform === 'win32' ? `win-${arch}-zip` : platform === 'darwin' ? `osx-${arch}-tar` : `linux-${arch}`;
    const version = index.filter(item => /^v\d+\.\d+\.\d+$/.test(item.version) && item.files.includes(fileType))
      .map(item => item.version.slice(1)).filter(value => matches(value, selector)).sort(compare)[0];
    if (!version) throw Error('No matching Node.js version for this platform.');
    const directory = `node-v${version}-${platform === 'win32' ? 'win' : platform}-${arch}`;
    const name = directory + (platform === 'win32' ? '.zip' : '.tar.gz');
    const base = `${nodeDist}/v${version}`;
    const asset = sums(await readCatalog(base + '/SHASUMS256.txt', request)).find(entry => entry.name === name);
    if (!asset) throw Error('The Node.js release has no checksum for this archive.');
    return {version, directory, url: base + '/' + name, digest: asset.digest};
  }
  const target = (arch === 'arm64' ? 'aarch64' : 'x86_64') + ({win32:'-pc-windows-msvc', darwin:'-apple-darwin', linux:'-unknown-linux-gnu'} as Record<string,string>)[platform];
  const suffix = '-' + target + '-install_only_stripped.tar.gz';
  const files = sums(await readCatalog(pythonReleases + '/latest/download/SHA256SUMS', request));
  const builds = files.flatMap(asset => {
    if (!asset.name.endsWith(suffix)) return [];
    const match = /^cpython-(\d+\.\d+\.\d+)\+(\d{8})$/.exec(asset.name.slice(0, -suffix.length));
    return match && matches(match[1], selector) ? [{version: match[1], directory: 'python', digest: asset.digest,
      url: `${pythonReleases}/download/${match[2]}/${encodeURIComponent(asset.name)}`}] : [];
  });
  const build = builds.sort((a, b) => compare(a.version, b.version))[0];
  if (!build) throw Error('No matching Python version in the current standalone release. Select a minor series or an installed version.');
  return build;
}
