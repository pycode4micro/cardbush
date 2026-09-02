import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.join(process.cwd(), 'assets', 'skills', 'video-understanding');
const skillPath = path.join(root, 'SKILL.md');
const scriptPath = path.join(root, 'scripts', 'video_storyboard.py');
const skill = fs.readFileSync(skillPath, 'utf8');
const script = fs.readFileSync(scriptPath, 'utf8');
const main = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8');
const builder = fs.readFileSync(path.join(process.cwd(), 'electron-builder.yml'), 'utf8');

assert.match(skill, /^---\r?\nname: video-understanding\r?\n/);
assert.match(skill, /description_zh:/);
assert.match(skill, /视频理解、视频分析、抽帧和逐帧观察/);
assert.match(skill, /terminal_exec/);
assert.match(skill, /inject_image_input/);
assert.match(skill, /--mode uniform/);
assert.match(skill, /--mode scenes/);
assert.match(skill, /--mode sequence/);
assert.match(skill, /audio was not analyzed|audio was not/i);
assert.match(script, /cardbush\.video_storyboard\.v1/);
assert.match(script, /choices=\("uniform", "scenes", "sequence"\)/);
assert.match(script, /sheet_size, 4, 20/);
assert.match(script, /uniform_supplements/);
assert.match(script, /video_storyboard_failed/);
assert.ok(fs.existsSync(path.join(root, 'assets', 'logo.svg')));
assert.ok(fs.existsSync(path.join(root, 'assets', 'logo-dark.svg')));
assert.match(main, /function bundledProductSkillRoot\(\)/);
assert.match(main, /process\.resourcesPath, 'skills'/);
assert.match(main, /const bundledSkillRoot = bundledProductSkillRoot\(\)/);
assert.match(builder, /!assets\/skills\/\*\*\/\*/);
assert.match(builder, /from: assets\/skills[\s\S]*?to: skills/);
assert.match(builder, /!\*\*\/__pycache__\/\*\*\/\*/);

const python = findPython();
if (python) {
  const help = spawnSync(python.command, [...python.prefix, scriptPath, '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /--check-dependencies/);
  assert.match(help.stdout, /--keep-frames/);

  const check = spawnSync(
    python.command,
    [...python.prefix, scriptPath, '--check-dependencies'],
    { cwd: process.cwd(), encoding: 'utf8', shell: false },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const payload = JSON.parse(check.stdout);
  assert.equal(payload.schema, 'cardbush.video_storyboard.v1');
  assert.equal(payload.operation, 'dependency_check');
  assert.equal(typeof payload.ready, 'boolean');
  assert.equal(typeof payload.modules.numpy, 'boolean');
}

console.log('video understanding Skill contract tests passed');

function findPython() {
  const candidates = process.platform === 'win32'
    ? [
        { command: 'py', prefix: ['-3'] },
        { command: 'python', prefix: [] },
      ]
    : [
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] },
      ];
  return candidates.find((candidate) => {
    const result = spawnSync(candidate.command, [...candidate.prefix, '--version'], {
      encoding: 'utf8',
      shell: false,
    });
    return result.status === 0;
  });
}
