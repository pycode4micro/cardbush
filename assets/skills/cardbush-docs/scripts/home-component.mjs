import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import files from './component-files.cjs';
import library from './home-library.cjs';

const { values, positionals } = parseArgs({allowPositionals:true, options: {
  output:{type:'string'}, id:{type:'string'}, title:{type:'string'}, html:{type:'string'}, script:{type:'string',multiple:true},
  style:{type:'string',multiple:true}, home:{type:'boolean'}, width:{type:'string'}, height:{type:'string'}, profile:{type:'string'},
  origin:{type:'string',multiple:true}, 'expected-revision':{type:'string'}
}});
const appData = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin'
  ? join(homedir(),'Library','Application Support') : process.env.XDG_CONFIG_HOME || join(homedir(),'.config');
const db = library.openLibrary(values.profile || join(appData,'cardbush'));
try {
  if (positionals.length !== 1) throw Error('Expected list, export or publish.');
  if (positionals[0] === 'list') {
    console.log(JSON.stringify(db.snapshot().items.map(library.componentInfo)));
  } else if (positionals[0] === 'export' && values.id && values.output) {
    const {revision,items} = db.snapshot();
    const item = items.find(item => item.id === values.id);
    if (!item) throw Error('COMPONENT_NOT_FOUND');
    await writeFile(values.output,item.html,{flag:'wx'});
    console.log(JSON.stringify({...library.componentInfo(item),revision,output:values.output}));
  } else if (positionals[0] === 'publish' && values.id) {
    const paths = [values.html,...(values.style ?? []),...(values.script ?? [])].filter(Boolean);
    const html = files.assembleComponent(await Promise.all(paths.map(async path => ({name:basename(path),text:await readFile(path,'utf8')}))));
    const result = db.publish({id:values.id,title:values.title,html,networkDomains:values.origin,
      width:values.width === undefined ? undefined : Number(values.width),height:values.height === undefined ? undefined : Number(values.height)},
      values.home, values['expected-revision'] === undefined ? undefined : Number(values['expected-revision']));
    const {id,title,home} = result.items.find(item => item.id === values.id);
    console.log(JSON.stringify({id,title,home,revision:result.revision}));
  } else throw Error('Usage: home-component.mjs publish --id ID --title TITLE --html FILE [--style FILE] [--script FILE] [--home]');
} finally { db.close(); }
