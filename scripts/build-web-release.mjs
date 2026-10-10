// Preserve the exact shared renderer inputs alongside a deployable browser build.
// This does not rebuild or publish the Agent runtime packages.
import { build } from 'vite';
import ts from 'typescript';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
const root=resolve('.'), files=new Set();
const include=path=>{const rel=relative(root,path).replaceAll('\\','/');if(!isAbsolute(rel)&&!rel.startsWith('../')&&!rel.includes('node_modules/')&&existsSync(path))files.add(rel);};
const config=ts.readConfigFile('tsconfig.web.json',ts.sys.readFile);
if(config.error)throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
const program=ts.createProgram(parsed.fileNames,parsed.options);
const errors=ts.getPreEmitDiagnostics(program);
if(errors.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>root,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));
for(const file of program.getSourceFiles())include(file.fileName);
await build({configFile:'vite.web.config.mts',plugins:[{name:'renderer-source-manifest',generateBundle(){for(const id of this.getModuleIds())if(!id.startsWith('\0'))include(id.split('?')[0]);}}]});
await mkdir('tmp/web-render-release',{recursive:true});
await writeFile('tmp/web-render-release/renderer-inputs.json',JSON.stringify([...files].sort(),null,2));
console.log(`Recorded ${files.size} local renderer source/dependency files.`);
