import { BrowserWindow, session } from 'electron';
import path from 'node:path';
import type { HomeItem } from './homeComponentTools.mjs' with { 'resolution-mode': 'import' };

let busy = false;
export async function previewHomeComponent(item:HomeItem, signal:AbortSignal, devUrl?:string) {
  signal.throwIfAborted();
  if (busy) throw Error('COMPONENT_PREVIEW_BUSY');
  const ses = session.fromPartition('cardbush-home-preview');
  const blockDownload = (event:Electron.Event) => event.preventDefault();
  ses.setPermissionRequestHandler((_web,_permission,callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({show:false,width: Math.round(900 * item.width / 12),height:item.height,useContentSize:true,
    skipTaskbar:true,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,
      preload:path.join(__dirname,'homeComponentPreviewPreload.js')}});
  busy = true;
  ses.on('will-download',blockDownload);
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({action:'deny'}));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => { if (!event.isMainFrame && event.url !== 'about:srcdoc') event.preventDefault(); });
  ses.webRequest.onBeforeRequest((request,callback) => {
    // Only the trusted parent may load application assets. The sandboxed guest is offline.
    const guest = request.resourceType === 'subFrame' || request.frame?.parent != null;
    callback({cancel:guest && !/^(?:data:|blob:|about:srcdoc$)/.test(request.url)});
  });
  let timer:ReturnType<typeof setTimeout>|undefined, rejectRun:(cause:Error)=>void=()=>{};
  const abort = () => rejectRun(Error('COMPONENT_PREVIEW_CANCELLED'));
  try {
    const interrupted = new Promise<never>((_, reject) => {
      rejectRun = reject;
      timer = setTimeout(() => reject(Error('COMPONENT_PREVIEW_TIMEOUT')), 15000);
      contents.once('render-process-gone', () => reject(Error('COMPONENT_PREVIEW_FAILED')));
    });
    const ready = new Promise<void>(resolve => {
      contents.ipc.handle('component-preview:read',event => {
        if (event.senderFrame !== contents.mainFrame) throw Error('INVALID_SENDER');
        return {id:item.id,title:item.title,html:item.html,width:item.width,height:item.height,order:0,allowActions:false};
      });
      contents.ipc.on('component-preview:ready',event => { if(event.senderFrame===contents.mainFrame) resolve(); });
    });
    signal.addEventListener('abort',abort,{once:true});
    const loading = devUrl ? win.loadURL(new URL('component-preview.html',devUrl).href) : win.loadFile(path.join(__dirname,'../dist/component-preview.html'));
    await Promise.race([interrupted, Promise.all([ready,loading])]);
    signal.throwIfAborted();
    const image = await Promise.race([interrupted, contents.capturePage(undefined,{stayHidden:true,stayAwake:true})]);
    if(image.isEmpty()) throw Error('COMPONENT_PREVIEW_EMPTY');
    return image.toPNG().toString('base64');
  } finally {
    clearTimeout(timer);signal.removeEventListener('abort',abort);
    if(!win.isDestroyed()) win.destroy();
    ses.webRequest.onBeforeRequest(null); ses.removeListener('will-download',blockDownload); busy=false;
  }
}
