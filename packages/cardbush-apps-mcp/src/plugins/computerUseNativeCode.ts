import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { addComputerUseTimings } from './computerUseTimings.js';

const execute = promisify(execFile);
// PowerShell cannot load a DLL through Electron's virtual ASAR filesystem.
const bundledDirectory = fileURLToPath(new URL('../native/', import.meta.url)).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
const pending = new Map<string, Promise<string>>();
const exists = async (path: string) => access(path).then(() => true, () => false);
export const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Extract only our literal C# declarations. Dynamic/user scripts are never
 * passed here. Immutable assemblies survive calls; no executor stays alive. */
export async function prepareComputerUseNativeCode(script: string, outputDirectory?: string): Promise<string> {
  const blocks = [...script.matchAll(/^[ \t]*Add-Type ([^\r\n]*?)-TypeDefinition @'\r?\n([\s\S]*?)^[ \t]*'@([^\r\n]*)/gm)];
  let prepared = script;
  for (const block of blocks.reverse()) {
    const flags = `${block[1]} ${block[3]}`;
    const references = flags.match(/-ReferencedAssemblies\s+([\w.,]+)/)?.[1]?.split(',') ?? [];
    if (flags.replace(/-ReferencedAssemblies\s+[\w.,]+/, '').trim()) throw new Error('Unsupported Computer Use native compiler options.');
    const source = block[2]!.replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update('computer-use-native-v2\n').update(source).update(JSON.stringify(references)).digest('hex');
    const filename = `CardBush-${hash}.dll`;
    const bundled = join(outputDirectory ?? bundledDirectory, filename);
    let assembly = bundled;
    if (!(await exists(bundled))) {
      const cache = outputDirectory ?? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'CardBush', 'computer-use-native');
      assembly = join(cache, filename);
      if (!(await exists(assembly))) {
        let compiling = pending.get(assembly);
        if (!compiling) {
          compiling = compileNative(source, references, assembly).finally(() => pending.delete(assembly));
          pending.set(assembly, compiling);
        }
        assembly = await compiling;
      }
    }
    const load = `$cardbushLoad = [Diagnostics.Stopwatch]::StartNew()\nAdd-Type -Path ${quotePowerShell(assembly)}\nif ($null -ne $script:CardBushTimings) { $script:CardBushTimings.initialization_ms += $cardbushLoad.ElapsedMilliseconds }`;
    prepared = prepared.slice(0, block.index!) + load + prepared.slice(block.index! + block[0].length);
  }
  return prepared.replace(/^([ \t]*Add-Type -AssemblyName [^\r\n]+)$/gm,
    "$cardbushAssemblyLoad = [Diagnostics.Stopwatch]::StartNew()\n$1\nif ($null -ne $script:CardBushTimings) { $script:CardBushTimings.initialization_ms += $cardbushAssemblyLoad.ElapsedMilliseconds }");
}

async function compileNative(source: string, references: string[], output: string): Promise<string> {
  const started = performance.now();
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map(name => join(windows, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe'));
  const compiler = (await Promise.all(candidates.map(async path => await exists(path) ? path : undefined))).find(Boolean);
  if (!compiler) throw new Error('The Windows .NET Framework compiler is unavailable for Computer Use.');
  const directory = dirname(output);
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, 'compile-'));
  try {
    const sourcePath = join(temporary, 'helper.cs');
    // CLR identity comes from the compiler output name, not the renamed path.
    // Different helpers must remain distinct when loaded into the same process.
    const compiled = join(temporary, basename(output));
    await writeFile(sourcePath, '\ufeff' + source);
    await execute(compiler, ['/nologo', '/target:library', '/optimize+', '/utf8output', `/out:${compiled}`,
      ...references.map(value => `/reference:${value.endsWith('.dll') ? value : value + '.dll'}`), sourcePath],
    { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    try { await rename(compiled, output); }
    catch (error) { if (!(await exists(output))) throw error; }
    return output;
  } finally {
    // Only the directory created above belongs to this compilation.
    if (!resolve(temporary).startsWith(resolve(directory) + sep + 'compile-')) throw new Error('Invalid native build temporary directory.');
    await rm(temporary, { recursive: true, force: true });
    addComputerUseTimings({ compile_ms: performance.now() - started });
  }
}
