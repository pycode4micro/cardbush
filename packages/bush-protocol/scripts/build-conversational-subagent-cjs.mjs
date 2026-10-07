import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

// The renderer/runtime use ESM; Electron's voice provider still uses require().
// Generate that compatibility entry from the same typechecked source so schema
// validation and tool descriptions cannot drift between the two transports.
const source = new URL('../src/conversationalSubagentTools.ts', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const stem = 'conversationalSubagentTools';
const result = ts.transpileModule(await readFile(source, 'utf8'), {
  fileName: `${stem}.ts`,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, sourceMap: true },
});
const sourceMap = JSON.parse(result.sourceMapText);
sourceMap.file = `${stem}.cjs`;
sourceMap.sources = [`../src/${stem}.ts`];
await writeFile(new URL(`${stem}.cjs`, output), result.outputText.replace(
  `sourceMappingURL=${stem}.js.map`, `sourceMappingURL=${stem}.cjs.map`));
await writeFile(new URL(`${stem}.cjs.map`, output), JSON.stringify(sourceMap));

const declaration = await readFile(new URL(`${stem}.d.ts`, output), 'utf8');
const declarationMap = JSON.parse(await readFile(new URL(`${stem}.d.ts.map`, output), 'utf8'));
declarationMap.file = `${stem}.d.cts`;
await writeFile(new URL(`${stem}.d.cts`, output), declaration.replace(
  `sourceMappingURL=${stem}.d.ts.map`, `sourceMappingURL=${stem}.d.cts.map`));
await writeFile(new URL(`${stem}.d.cts.map`, output), JSON.stringify(declarationMap));
