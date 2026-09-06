import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { suite } from './coding-benchmark/suite.mjs';
import { containedPath, createRunRoot, gradeTask, prepareTask, publicTest, suiteIdentity } from './coding-benchmark/harness.mjs';

const { values } = parseArgs({ options: {
  'self-check': { type: 'boolean' }, prepare: { type: 'boolean' }, grade: { type: 'string' }, live: { type: 'boolean' },
  tasks: { type: 'string' }, label: { type: 'string', default: 'unlabelled' },
  config: { type: 'string' }, 'model-id': { type: 'string' }, model: { type: 'string' },
  reasoning: { type: 'string', default: 'high' }, 'max-rounds': { type: 'string', default: '24' },
  'timeout-ms': { type: 'string', default: '300000' }, 'token-stop': { type: 'string', default: '150000' },
  'max-output-tokens': { type: 'string', default: '4096' },
} });
if ([values['self-check'], values.prepare, values.grade, values.live].filter(Boolean).length > 1) {
  throw new Error('Choose one mode: --self-check, --prepare, --grade <run-dir>, or --live.');
}
const mode = values.live ? 'live' : values.prepare ? 'prepare' : values.grade ? 'grade' : 'self-check';
const selectedIds = values.tasks?.split(',');
if (selectedIds?.some(id => !suite.some(task => task.id === id))) throw new Error('Unknown task id in --tasks.');
let tasks = suite.filter(task => !selectedIds || selectedIds.includes(task.id));
const identity = await suiteIdentity();
let manifest;
const root = values.grade ? resolve(values.grade) : await createRunRoot();
if (values.grade) {
  manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.suiteHash !== identity.suiteHash) throw new Error('Run was prepared with a different suite; use its original checkout to grade.');
  tasks = tasks.filter(task => manifest.tasks.some(entry => entry.id === task.id));
  if (!tasks.length) throw new Error('No selected tasks exist in the prepared run.');
} else {
  manifest = { protocol: 'cardbush.coding_benchmark_manifest.v1', ...identity, tasks: [] };
}

// Live calls require an explicit flag and locally supplied credentials. Default
// npm tests only exercise the offline, deterministic fixtures.
const live = mode === 'live' ? await import('./coding-benchmark/live.mjs') : undefined;
const liveOptions = live ? await live.configure(values) : undefined;
const report = {
  protocol: 'cardbush.coding_benchmark_report.v1', mode, label: values.label,
  createdAt: new Date().toISOString(), nodeVersion: process.version, platform: process.platform, architecture: process.arch, ...identity,
  ...(liveOptions ? { model: liveOptions.publicConfig } : {}), tasks: [],
};
let failed = false;
for (const task of tasks) {
  await mkdir(join(root, task.id), { recursive: true });
  const workspace = values.grade
    ? containedPath(root, manifest.tasks.find(entry => entry.id === task.id).workspace)
    : await prepareTask(task, root);
  if (!values.grade) manifest.tasks.push({ id: task.id, category: task.category, prompt: task.prompt, workspace: relative(root, workspace) });
  let result = { id: task.id, category: task.category, workspace };
  if (mode === 'self-check') {
    const defective = await gradeTask(task, workspace);
    const reference = await prepareTask(task, root, { broken: false });
    const corrected = await gradeTask(task, reference);
    const smoke = await publicTest(reference);
    const passed = !defective.passed && defective.failureKind === 'assertion' && corrected.passed && smoke.exitCode === 0;
    result = { ...result, passed, defective, reference: corrected, publicTest: smoke };
    failed ||= !passed;
  } else if (mode !== 'prepare') {
    const execution = live ? await live.runTask(task, workspace, join(root, task.id, 'runtime'), liveOptions) : undefined;
    const grade = await gradeTask(task, workspace);
    result = { ...result, passed: grade.passed, ...(execution ? { execution } : {}), grade };
    failed ||= !grade.passed;
  }
  report.tasks.push(result);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(root, `${mode}-report.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ task: task.id, mode, passed: result.passed ?? null }));
}
console.log(JSON.stringify({ mode, runRoot: root, reportPath: join(root, `${mode}-report.json`),
  ...(mode !== 'prepare' ? { passed: report.tasks.filter(task => task.passed).length, total: tasks.length } : {}),
}));
if (failed) process.exitCode = 1;
