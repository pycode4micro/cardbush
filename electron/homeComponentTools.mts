import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export type HomeItem = { id:string; title:string; html:string; width:number; height:number; order:number; home?:boolean; allowActions:boolean;
  networkDomains?:string[]; approvedNetworkOrigins?:string[] };
export type HomeSnapshot = { version:1; revision:number; items:HomeItem[] };
export type HomeToolHost = {
  snapshot(): HomeSnapshot | null;
  describe(item:HomeItem): Omit<HomeItem,'html'> & {length:number; bytes:number; sha256:string};
  publish(item: Partial<HomeItem> & Pick<HomeItem,'id'|'html'>, home:boolean|undefined, revision:number): HomeSnapshot;
};
export type HomePreview = (item:HomeItem, signal:AbortSignal) => Promise<string>;
const id = z.string().regex(/^(?!system-)[a-z0-9-]{1,80}$/i);
const text = (value:unknown) => ({content:[{type:'text' as const, text:JSON.stringify(value)}]});
const failure = (cause:unknown) => ({isError:true,content:[{type:'text' as const,text:cause instanceof Error ? cause.message : 'COMPONENT_FAILED'}]});
const lookup = (state:HomeSnapshot, key:string) => {
  const item = state.items.find(item => item.id === key);
  if (!item) throw Error('COMPONENT_NOT_FOUND');
  return item;
};

export function registerHomeComponentTools(server:McpServer, host:()=>HomeToolHost, preview?:HomePreview) {
  const metadata = (item:HomeItem) => host().describe(item);
  const snapshot = () => { const state = host().snapshot(); if (!state) throw Error('COMPONENT_LIBRARY_UNAVAILABLE'); return state; };
  server.registerTool('read_home_component', {
    description:'List installed Home widgets/components in this desktop profile, or inspect one by ID. Supply offset or find for a bounded slice of its actual HTML. Use this and edit_home_component for widget work, including existing components; no source checkout, SQLite access or second app instance is needed. Requested network origins are not user grants.',
    inputSchema:{id:id.optional(), offset:z.number().int().nonnegative().optional(),find:z.string().min(1).max(1000).optional(),limit:z.number().int().min(1).max(12000).default(4000)},
    annotations:{readOnlyHint:true,openWorldHint:false},
  }, async ({id, offset,find,limit}) => { try {
    const state=snapshot();
    if (!id) return text({revision:state.revision,items:state.items.map(metadata)});
    const item=lookup(state,id);
    const start=find ? item.html.indexOf(find,offset ?? 0) : offset ?? 0;
    if(start<0) throw Error('TEXT_NOT_FOUND');
    return text({revision:state.revision,...metadata(item),offset:start,source:item.html.slice(start,start+limit),
      nextOffset:start+limit<item.html.length ? start+limit : null});
  } catch(cause) {return failure(cause);} });
  server.registerTool('edit_home_component', {
    description:'Create or update one installed Home widget in place. Use the revision from read_home_component. For updates prefer exact unique replacements, in order. Other widgets, placement, size and widget state are preserved unless explicitly changed. Content changes revoke existing grants. networkDomains requests exact HTTPS origins for cardbush.net.fetchJson; only the user can approve them in the component editor. Never patch host code, build output or relax the sandbox to edit or verify a widget.',
    inputSchema:{id,mode:z.enum(['create','update']),expectedRevision:z.number().int().nonnegative(),title:z.string().trim().min(1).max(80).optional(),
      html:z.string().min(1).max(262144).optional(), replacements:z.array(z.object({before:z.string().min(1).max(65536),after:z.string().max(65536)})).min(1).max(24).optional(),
      home:z.boolean().optional(),width:z.number().int().min(3).max(12).optional(),height:z.number().int().min(120).max(1200).optional(),
      networkDomains:z.array(z.string().max(260)).max(8).optional()},
    annotations:{readOnlyHint:false,openWorldHint:false},
  }, async ({id,mode,expectedRevision,html,replacements,title,width,height,home,networkDomains}) => { try {
    const state=snapshot();
    if(state.revision!==expectedRevision) throw Error('REVISION_CONFLICT');
    const previous=state.items.find(item=>item.id===id);
    if(mode==='create' && (previous || !title || !html)) throw Error(previous?'COMPONENT_ALREADY_EXISTS':'TITLE_AND_HTML_REQUIRED');
    if(mode==='update' && !previous) throw Error('COMPONENT_NOT_FOUND');
    if(html!==undefined && replacements) throw Error('CHOOSE_HTML_OR_REPLACEMENTS');
    let source=html ?? previous!.html;
    for(const {before,after} of replacements ?? []) {
      const at=source.indexOf(before);
      if(at<0 || source.indexOf(before,at+1)>=0) throw Error('PATCH_CONTEXT_NOT_UNIQUE');
      source=source.slice(0,at)+after+source.slice(at+before.length);
    }
    const next=host().publish({id,title,html:source,width,height,networkDomains},home,expectedRevision);
    return text({revision:next.revision,...metadata(lookup(next,id))});
  } catch(cause) {return failure(cause);} });
  if(preview) server.registerTool('preview_home_component',{
    description:'Render one installed Home widget and return its screenshot in an isolated, offline desktop preview. No live conversation, saved widget state, network or actions. Confirms layout only, not live data freshness. Does not navigate the user’s window.',
    inputSchema:{id}, annotations:{readOnlyHint:true,openWorldHint:false},
  },async({id},context)=>{try {
    const state=snapshot(),item=lookup(state,id),data=await preview(item,context.mcpReq.signal);
    return {content:[...text({id,revision:state.revision,sha256:metadata(item).sha256,mode:'offline-preview'}).content,{type:'image' as const,mimeType:'image/png',data}]};
  } catch(cause){return failure(cause);} });
}
