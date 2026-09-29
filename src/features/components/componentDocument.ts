import { componentProtocol } from './componentModel';
import { componentId } from './componentId';

/** The document stays opaque-origin; HTML cannot access Electron, app storage or network. */
export function componentDocument(html: string, token: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('base,meta[http-equiv]').forEach(node => node.remove());
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const style = doc.createElement('style');
  style.textContent = 'html{color:var(--cb-text);background:var(--cb-background);font:var(--cb-font-size,14px)/1.6 var(--cb-font,system-ui);color-scheme:var(--cb-color-scheme)}body{margin:16px;overflow-wrap:anywhere}*{box-sizing:border-box}input,textarea,select,button{font:inherit;color:inherit}input,textarea,select{background:var(--cb-surface);border:1px solid var(--cb-border)}button{background:var(--cb-surface);border:1px solid var(--cb-border);border-radius:8px;padding:6px 12px}a{color:var(--cb-accent)}html[data-reduce-motion=true] *,html[data-reduce-motion=true] *::before,html[data-reduce-motion=true] *::after{animation-duration:.01ms!important;transition-duration:.01ms!important}';
  const script = doc.createElement('script');
  script.textContent = `(()=>{
    const protocol=${JSON.stringify(componentProtocol)},token=${JSON.stringify(token)},pending=new Map(),listeners=new Map();let sequence=0,context=null,resolveReady;
    const ready=new Promise(resolve=>resolveReady=resolve);
    const newId=${componentId.toString()};
    function request(method,params={}) {if(pending.size>=8)return Promise.reject(new Error('BUSY'));return new Promise((resolve,reject)=>{const id=String(++sequence);const timer=setTimeout(()=>{pending.delete(id);reject(new Error('TIMEOUT; action status may be unknown, do not retry automatically'));},30000);pending.set(id,{resolve,reject,timer});parent.postMessage({protocol,token,jsonrpc:'2.0',id,method,params},'*');});}
    addEventListener('message',event=>{const m=event.data;if(event.source!==parent||!m||m.protocol!==protocol||m.token!==token)return;
      if(m.id){const item=pending.get(m.id);if(!item)return;clearTimeout(item.timer);pending.delete(m.id);m.error?item.reject(new Error(m.error)):item.resolve(m.result);return;}
      if(m.topic==='host.context'){context=m.value;resolveReady(context);}
      if(m.topic==='theme.changed'){document.documentElement.dataset.reduceMotion=m.value['--cb-reduced-motion']==='1'?'true':'false';for(const [key,value] of Object.entries(m.value))document.documentElement.style.setProperty(key,String(value));}
      for(const callback of listeners.get(m.topic)||[])try{callback(m.value);}catch(error){console.error(error);}
    });
    window.cardbush=Object.freeze({version:1,ready,get context(){return context;},
      read:()=>request('context.read'),state:{read:()=>request('state.read'),write:value=>request('state.write',{value})},
      subscribe:(topic,callback)=>{if(!listeners.has(topic))listeners.set(topic,new Set());listeners.get(topic).add(callback);return()=>listeners.get(topic)?.delete(callback);},
      invoke:async(command,args={},key)=>{await ready;return request('actions.invoke',{command,args,contextRevision:context.revision,idempotencyKey:key||newId()});}
    });
  })();`;
  doc.head.prepend(policy, style, script);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
