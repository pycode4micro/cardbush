import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './suite.mjs';

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const referenceRoot = fileURLToPath(new URL('./reference', import.meta.url));
const loader = new URL('./register-loader.mjs', import.meta.url).href;
const grader = fileURLToPath(new URL('./grader.mjs', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function suiteIdentity() {
  const sources = JSON.parse(await readFile(join(referenceRoot, 'sources.json'), 'utf8'));
  for (const [path, hash] of Object.entries(sources.hashes)) {
    if (sha256(await readFile(join(referenceRoot, path))) !== hash) {
      throw new Error(`Reference snapshot hash mismatch: ${path}`);
    }
  }
  const files = ['suite.mjs', 'grader.mjs', 'harness.mjs', 'register-loader.mjs', 'typescript-loader.mjs', 'reference/sources.json'];
  const hashes = {};
  for (const path of files) hashes[path] = sha256(await readFile(new URL(path, import.meta.url)));
  return { suiteHash: sha256(JSON.stringify(hashes)), sources, harnessHashes: hashes };
}

export async function createRunRoot() {
  const parent = join(projectRoot, 'tmp', 'coding-benchmark');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'run-'));
}

export function taskWorkspace(runRoot, id, variant = 'candidate') {
  if (!suite.some(task => task.id === id) || !['candidate', 'reference'].includes(variant)) {
    throw new Error('Unknown task or workspace variant.');
  }
  return join(runRoot, id, variant);
}

export async function prepareTask(task, runRoot, { broken = true } = {}) {
  const workspace = taskWorkspace(runRoot, task.id, broken ? 'candidate' : 'reference');
  await mkdir(workspace, { recursive: false });
  for (const path of task.files) {
    let source = await readFile(join(referenceRoot, path), 'utf8');
    if (broken) for (const mutation of task.mutations.filter(item => item.path === path)) {
      if (source.split(mutation.before).length !== 2) throw new Error(`Mutation is not unique: ${task.id}/${path}`);
      source = source.replace(mutation.before, mutation.after);
    }
    const destination = join(workspace, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
  // The public test only checks imports and existing, unaffected behavior. The
  // agent can add regression tests; grading assertions stay outside this tree.
  const imports = task.files.map((path, index) => `const module${index} = await import(${JSON.stringify('./' + path)});`).join('\n');
  const smoke = task.id.startsWith('queue-')
    ? "const items = [{ id: 'a', scope: 'x' }]; assert.equal(module0.reorderScopedQueue(items, 'a', 'a', x => x.id, x => x.scope), items);"
    : task.id === 'context-usage'
      ? 'assert.equal(module0.contextWindowMetrics(undefined, 1000).maxTokens, 1000);'
      : task.id === 'config-concurrency'
        ? "assert.equal(await module0.withConfigFileLock('smoke', async () => 7), 7);"
        : task.id === 'markdown-code-boundary'
          ? "assert.equal(module0.normalizeMarkdownContentForDisplay('plain text'), 'plain text');"
          : task.id === 'file-reference-boundary'
            ? "assert.equal(typeof module0.remarkLocalFileReferences, 'function');"
            : "assert.equal(module0.isAudioPath('C:\\\\audio.mp3'), true);";
  await writeFile(join(workspace, 'test.mjs'), `import assert from 'node:assert/strict';\nglobalThis.window = { cardbushDesktop: {} };\n${imports}\n${smoke}\nconsole.log('Public smoke test passed; add regression tests for the task.');\n`);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: `cardbush-benchmark-${task.id}`, private: true, type: 'module',
    scripts: { test: `node --import ${JSON.stringify(loader)} test.mjs` },
  }, null, 2) + '\n');
  await writeFile(join(workspace, 'TASK.md'), `${task.prompt}\n\n运行 npm test。TypeScript loader 已提供，无需安装依赖。可以修改源代码和添加测试。只在当前工作目录内工作。\n`);
  return workspace;
}

export async function gradeTask(task, workspace) {
  const result = await runNode(['--import', loader, grader, task.id, workspace], workspace);
  let evidence;
  try { evidence = JSON.parse(result.stdout.trim()); } catch { /* Failure output is captured separately. */ }
  return {
    passed: result.exitCode === 0 && evidence?.taskId === task.id && evidence?.passed === true,
    failureKind: result.exitCode === 0 ? null : /ERR_ASSERTION|AssertionError/.test(result.stderr) ? 'assertion' : 'execution',
    ...result,
  };
}

export async function publicTest(workspace) {
  return runNode(['--import', loader, 'test.mjs'], workspace);
}

export function runNode(args, cwd, timeoutMs = 20_000) {
  return new Promise(resolveResult => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-12_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12_000); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { stderr += `\n${error.code ?? error.name}: ${error.message}`; });
    child.once('close', code => {
      clearTimeout(timer);
      resolveResult({ exitCode: code, timedOut, durationMs: Date.now() - started, stdout, stderr });
    });
  });
}

export function containedPath(root, path) {
  const result = resolve(root, path);
  const rel = relative(resolve(root), result);
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('Task workspace must be inside its run directory.');
  }
  return result;
}
