// SPDX-License-Identifier: Apache-2.0
import { access, copyFile, link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, extname, join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runResourceManagedCommand } from '@cardbush/bush-runtime/processes';
import { absolute, assertFormat, fileBytes, fingerprint, officePackage, safeForOfficeConversion } from './files.mjs';
import { validateDocument, workbookStructure } from './inspect.mjs';
import { libraries, pdfReader } from './sdk.mjs';

async function absent(file) {
  try { await access(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Output already exists. Choose a new path: ${file}`);
}
export async function withOutputs(paths, operation) {
  const outputs = paths.map(absolute);
  const keys = outputs.map(path => process.platform === 'win32' ? path.toLowerCase() : path);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate output paths.');
  for (const file of outputs) await absent(file);
  // The parent owns this directory, including cleanup after a killed worker.
  const root = await mkdtemp(join(process.env.CARDBUSH_DOCUMENT_JOB_ROOT ?? tmpdir(), 'cardbush-documents-'));
  const stages = outputs.map((file, index) => join(root, `${index}-${basename(file)}`));
  const published = [];
  try {
    const receipt = await operation(stages, root);
    const hashes = await Promise.all(stages.map(fingerprint));
    for (const [index, file] of outputs.entries()) {
      await mkdir(dirname(file), { recursive: true });
      const temporary = join(dirname(file), `.cardbush-${randomUUID()}.tmp`);
      try {
        await copyFile(stages[index], temporary, constants.COPYFILE_EXCL);
        await link(temporary, file); // Exclusive, complete publication on the destination filesystem.
        published.push({ file, hash: hashes[index] });
      } finally { await rm(temporary, { force: true }); }
    }
    return { ...receipt, outputs: await Promise.all(outputs.map(async (path, index) => ({ path, sha256: hashes[index], bytes: (await stat(path)).size }))) };
  } catch (error) {
    for (const { file, hash } of published) {
      if (await fingerprint(file).catch(() => '') === hash) await rm(file, { force: true });
    }
    throw error;
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function authorDocument(kind, request) {
  for (const file of request.outputs) {
    assertFormat(kind, file);
    if (extname(file).toLowerCase() === '.doc') throw new Error('Author Word files as DOCX; DOC is a legacy read/conversion input.');
    if (extname(file).toLowerCase() === '.potx') throw new Error('Author presentations as PPTX; POTX templates are read/conversion inputs.');
  }
  return withOutputs(request.outputs, async (outputs, root) => {
    const inputs = [], originals = [];
    for (const [index, source] of (request.inputs ?? []).entries()) {
      const file = absolute(source.path), hash = await fingerprint(file);
      if (source.sha256 && source.sha256 !== hash) throw new Error('Input changed since inspection. Inspect again before editing.');
      await fileBytes(file); // Admission before copying/loading into a document library.
      const target = join(root, `input-${index}-${basename(file)}`);
      await copyFile(file, target, constants.COPYFILE_EXCL);
      if (await fingerprint(target) !== hash) throw new Error('Input changed during copying.');
      inputs.push(target); originals.push({ file, hash });
    }
    const tools = await libraries(kind);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const previous = process.cwd();
    try {
      process.chdir(root);
      await new AsyncFunction('tools', 'inputs', 'outputs', request.code)(tools, inputs, outputs);
    } finally { process.chdir(previous); }
    const validations = await Promise.all(outputs.map(file => validateDocument(kind, file)));
    for (const { file, hash } of originals) if (await fingerprint(file) !== hash) throw new Error('An original changed during editing; outputs were not published.');
    return { status: 'created', validations,
      note: 'Structure was checked. Review formula results and render the output before claiming calculation or visual correctness.' };
  });
}

export async function findOffice() {
  const candidates = [process.env.CARDBUSH_SOFFICE, process.env.SOFFICE_PATH,
    ...(process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:/Program Files', 'LibreOffice/program/soffice.com'),
      join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'LibreOffice/program/soffice.com')] :
      ['/usr/bin/libreoffice', '/usr/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(dir =>
      (process.platform === 'win32' ? ['soffice.com', 'soffice.exe'] : ['soffice', 'libreoffice']).map(name => join(dir, name)))].filter(Boolean);
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try the next declared location. */ }
  }
  return null;
}

export async function convertDocument(kind, request) {
  const source = absolute(request.path); assertFormat(kind, source);
  const office = await findOffice();
  if (!office) throw Object.assign(new Error('LibreOffice is unavailable. Install it or set CARDBUSH_SOFFICE to its executable. Reading and authoring remain available; no conversion or recalculation was performed.'), { code: 'document_engine_unavailable' });
  const extension = extname(request.output).slice(1).toLowerCase();
  const allowed = kind === 'xlsx' ? ['xlsx', 'pdf'] : kind === 'docx' ? ['docx', 'pdf'] : ['pptx', 'pdf'];
  if (!allowed.includes(extension)) throw new Error('Unsupported conversion output.');
  const hash = await fingerprint(source);
  if (request.expected_sha256 && request.expected_sha256 !== hash) throw new Error('Document changed since inspection.');
  const bytes = await fileBytes(source);
  const packageInput = extname(source).toLowerCase() !== '.doc' ? await officePackage(bytes) : null;
  if (packageInput) await safeForOfficeConversion(packageInput);
  const before = kind === 'xlsx' ? await workbookStructure(packageInput, true) : null;
  return withOutputs([request.output], async ([output], root) => {
    const input = join(root, `source${extname(source)}`), converted = join(root, 'converted'), profile = join(root, 'profile');
    await writeFile(input, bytes); await mkdir(converted); await mkdir(join(profile, 'user'), { recursive: true });
    await writeFile(join(profile, 'user/registrymodifications.xcu'), `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>`);
    const convertedResult = await runResourceManagedCommand({ executable: office,
      args: [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--convert-to',
        extension === 'xlsx' ? 'xlsx:Calc MS Excel 2007 XML' : extension, '--outdir', converted, input],
      cwd: root, timeoutMs: 90_000, maxOutputBytes: 32_768 });
    if (convertedResult.exitCode !== 0) throw new Error(`LibreOffice failed (${convertedResult.exitCode}): ${convertedResult.stderr.slice(-1000)}`);
    const candidate = join(converted, `source.${extension}`);
    const validation = await validateDocument(extension, candidate);
    if (extension === 'xlsx' && (validation.errorCount || validation.missingCaches)) throw new Error('Recalculation left error cells or missing cached values; output was not published.');
    if (extension === 'xlsx') {
      const after = await workbookStructure(await officePackage(await fileBytes(candidate)), true);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Recalculation changed worksheet order/names or formula locations; output was not published.');
    }
    if (await fingerprint(source) !== hash) throw new Error('Source changed during conversion.');
    await copyFile(candidate, output, constants.COPYFILE_EXCL);
    return { status: 'converted', engine: 'LibreOffice', validation: { ...validation,
      ...(extension === 'xlsx' ? { calculation: 'recalculated', businessLogic: 'not_checked' } : {}) } };
  });
}

export async function renderPdf(request) {
  const path = absolute(request.path); assertFormat('pdf', path);
  if (extname(request.output).toLowerCase() !== '.png') throw new Error('Render output must be PNG.');
  return withOutputs([request.output], async ([output]) => {
    const reader = await pdfReader(await fileBytes(path));
    try {
      const page = await reader.document.getPage(request.page ?? 1), viewport = page.getViewport({ scale: request.scale ?? 1.5 });
      if (viewport.width * viewport.height > 16_000_000) throw new Error('Page exceeds the render pixel budget. Reduce scale.');
      const canvas = reader.canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      await writeFile(output, canvas.toBuffer('image/png'));
      return { status: 'rendered', page: request.page ?? 1, width: canvas.width, height: canvas.height };
    } finally { await reader.close(); }
  });
}
