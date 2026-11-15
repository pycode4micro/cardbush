import * as THREE from 'three';
import { WebGPURenderer, RenderTarget } from 'three/webgpu';

window.graphics = { secure: isSecureContext, origin, status: 'loading' };
try {
  const wasm = await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]));
  graphics.wasm = wasm.instance instanceof WebAssembly.Instance;
  const moduleUrl = URL.createObjectURL(new Blob(['export default 7'], {type:'text/javascript'}));
  graphics.blobModule = (await import(moduleUrl)).default;
  URL.revokeObjectURL(moduleUrl);
  graphics.dataModule = (await import('data:text/javascript,export default 9')).default;
  graphics.asset = await (await fetch('https://graphics.example.org/payload.json')).json();
  graphics.blocked = await fetch('https://undeclared.example.org/no-access').then(() => false, () => true);
  const workerUrl = URL.createObjectURL(new Blob([
    `const canvas=new OffscreenCanvas(2,2),context=canvas.getContext('2d');
     context.fillStyle='rgb(0,255,0)';context.fillRect(0,0,2,2);
     postMessage({pixel:Array.from(context.getImageData(0,0,1,1).data)});`
  ], {type:'text/javascript'}));
  const worker = new Worker(workerUrl);
  graphics.worker = await new Promise((resolve,reject) => {worker.onmessage=e=>resolve(e.data);worker.onerror=reject;});
  worker.terminate(); URL.revokeObjectURL(workerUrl);
  const moduleWorker = new Worker('data:text/javascript,'+encodeURIComponent(
    `import {answer} from 'https://graphics.example.org/worker-module.js';postMessage(answer);`
  ), {type:'module'});
  graphics.moduleWorker = await new Promise((resolve,reject) => {moduleWorker.onmessage=e=>resolve(e.data);moduleWorker.onerror=reject;});
  moduleWorker.terminate();

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1,1,1,-1,0.1,10); camera.position.z=3;
  const geometry = new THREE.BoxGeometry(1.4,1.4,1.4);
  const material = new THREE.MeshBasicMaterial({color:0xff0000});
  const cube = new THREE.Mesh(geometry,material); cube.rotation.set(.2,.3,0); scene.add(cube);
  const gl = new THREE.WebGLRenderer({canvas:document.querySelector('#webgl'),preserveDrawingBuffer:true});
  gl.setSize(128,128,false); gl.render(scene,camera);
  const pixel = new Uint8Array(4), context = gl.getContext();
  context.readPixels(64,64,1,1,context.RGBA,context.UNSIGNED_BYTE,pixel);
  graphics.webgl = Array.from(pixel);

  const adapter = await navigator.gpu?.requestAdapter();
  graphics.adapter = !!adapter;
  if (adapter) {
    const gpu = new WebGPURenderer({canvas:document.querySelector('#webgpu')});
    await gpu.init(); gpu.setSize(128,128,false);
    material.color.set(0x00ff00);
    const target = new RenderTarget(128,128);
    gpu.setRenderTarget(target); await gpu.renderAsync(scene,camera);
    graphics.webgpu = Array.from(await gpu.readRenderTargetPixelsAsync(target,64,64,1,1));
    graphics.backend = gpu.backend.isWebGPUBackend === true;
    gpu.setRenderTarget(null); await gpu.renderAsync(scene,camera); target.dispose();
    addEventListener('pagehide',()=>gpu.dispose(),{once:true});
  }
  graphics.status = 'ready';
  document.querySelector('output').textContent = 'Three.js · WebGL2 · WebGPU · Worker · WASM';
  addEventListener('pagehide',()=>{gl.dispose();geometry.dispose();material.dispose();},{once:true});
} catch (error) { graphics.status='failed';graphics.error=String(error?.stack || error); }
