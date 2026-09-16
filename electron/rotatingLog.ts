import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** A bounded diagnostic log. Each scope retains at most three previous files. */
export function appendRotatingLog(file: string, value: unknown, maxBytes = 8 * 1024 * 1024) {
  mkdirSync(dirname(file), { recursive: true });
  let line = JSON.stringify(value);
  if (Buffer.byteLength(line, 'utf8') > maxBytes) line = JSON.stringify({ truncated: true, preview: line.slice(0, Math.floor(maxBytes / 8)) });
  line += '\n';
  if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
    rmSync(`${file}.3`, { force: true });
    for (let index = 2; index >= 1; index--) if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`);
    renameSync(file, `${file}.1`);
  }
  appendFileSync(file, line, 'utf8');
}
