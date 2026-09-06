import { readFile, access } from 'node:fs/promises';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (!specifier.startsWith('.')) throw error;
    for (const extension of ['.ts', '/index.ts']) {
      const candidate = new URL(specifier + extension, context.parentURL);
      try { await access(candidate); return { url: candidate.href, shortCircuit: true }; }
      catch { /* Keep the original module-resolution error if no candidate exists. */ }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
}
