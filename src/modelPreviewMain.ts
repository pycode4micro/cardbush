import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { ModelPreviewMetadata } from '../electron/modelPreview';
import './styles/modelPreview.css';

const root = document.getElementById('model-preview-root')!;
const parameters = new URLSearchParams(location.search);
const filePath = parameters.get('path') ?? '';
const fileName = filePath.split(/[\\/]/).at(-1) ?? filePath;
document.title = `${fileName} · Blender 只读预览`;
root.innerHTML = `
  <header><strong id="file-name"></strong><span class="readonly">只读</span></header>
  <div class="model-toolbar" role="toolbar" aria-label="三维查看工具">
    <select id="scenes" aria-label="场景" disabled></select>
    <button id="fit" disabled>适应窗口</button><button id="front" disabled>正视</button><button id="top" disabled>俯视</button>
    <label><input id="wireframe" type="checkbox" disabled>线框</label><label><input id="grid" type="checkbox" checked disabled>网格</label>
  </div>
  <main id="viewport" aria-label="只读三维场景"><div id="status" role="status">正在使用 Blender 准备场景…</div></main>
  <section id="error" role="alert" hidden><strong>无法显示三维预览</strong><p></p><button id="retry">重试预览</button></section>
  <div id="animation-controls" hidden>
    <select id="animations" aria-label="动画"></select><button id="play">播放</button>
    <input id="timeline" type="range" aria-label="动画进度" min="0" max="1" step="0.01" value="0"><output id="time">0.00 s</output>
  </div>
  <footer><span id="summary"></span><span>拖动旋转 · 滚轮缩放 · 右键平移</span></footer>
  <details id="objects-panel"><summary>场景对象 <span id="object-count"></span></summary><div id="objects"></div></details>
  <details id="info-panel"><summary>文件信息与预览范围</summary><div id="info"></div></details>`;

function element<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
element('file-name').textContent = fileName;
element('file-name').title = filePath;
const viewport = element('viewport');
const status = element('status');
const errorPanel = element('error');
const sceneSelect = element<HTMLSelectElement>('scenes');
const animationSelect = element<HTMLSelectElement>('animations');
const timeline = element<HTMLInputElement>('timeline');
let revision = 0;
let request: AbortController | null = null;
let activeRequestId: string | null = null;
let currentScene = '';
let view: ReturnType<typeof createSceneView> | null = null;

function releaseResource(resource: string) {
  void fetch(resource, { method: 'DELETE', keepalive: true }).catch(() => undefined);
}

function cancelRequest() {
  request?.abort();
  // Electron protocol handlers may outlive a cancelled fetch. Release the
  // owned conversion explicitly, including navigation/close via keepalive.
  if (activeRequestId) releaseResource(`cardbush-file://model-preview/resource/${activeRequestId}`);
  activeRequestId = null;
}

function displayError(error: unknown) {
  status.hidden = true;
  errorPanel.hidden = false;
  errorPanel.querySelector('p')!.textContent = error instanceof Error ? error.message : String(error);
  sceneSelect.disabled = sceneSelect.options.length === 0;
}

async function loadScene(scene = '') {
  if (scene) currentScene = scene;
  const generation = ++revision;
  cancelRequest();
  request = new AbortController();
  const requestId = activeRequestId = crypto.randomUUID();
  const signal = request.signal;
  view?.dispose();
  view = null;
  errorPanel.hidden = true;
  errorPanel.classList.remove('dependency-missing');
  errorPanel.querySelector('strong')!.textContent = '无法显示三维预览';
  status.hidden = false;
  status.textContent = '正在使用 Blender 准备场景…';
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.model-toolbar input, .model-toolbar button, .model-toolbar select')
    .forEach(control => { control.disabled = true; });
  element('animation-controls').hidden = true;
  element('objects').replaceChildren();
  element('object-count').textContent = '';
  element('summary').textContent = '';
  element('info').replaceChildren();
  let resource: string | undefined;
  let gltf: GLTF | undefined;
  try {
    const url = new URL('cardbush-file://model-preview/manifest');
    url.searchParams.set('path', filePath);
    url.searchParams.set('requestId', requestId);
    if (scene) url.searchParams.set('scene', scene);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`文件读取失败（${response.status}）。`);
    const result = await response.json() as ModelPreviewMetadata & { resource: string; size: number; error?: string; code?: string };
    if (result.error) {
      if (result.code === 'blender_missing') {
        errorPanel.classList.add('dependency-missing');
        errorPanel.querySelector('strong')!.textContent = '三维预览需要 Blender';
        throw new Error(`${filePath}\n\n未找到 Blender。安装后即可在此查看三维场景，无需手动启动软件。便携版可通过 CARDBUSH_BLENDER_PATH 指定位置。`);
      }
      if (result.code === 'timeout') throw new Error('Blender 转换超过 120 秒，请在 Blender 中检查场景复杂度后重试。');
      if (result.code === 'busy') throw new Error('正在准备其他三维预览，请稍后重试。');
      throw new Error(result.error);
    }
    resource = result.resource;
    if (signal.aborted) return;
    status.textContent = '正在加载三维视图…';
    const bytes = await fetch(resource, { signal }).then(response => {
      if (!response.ok) throw new Error('临时预览已过期，请重试。');
      return response.arrayBuffer();
    });
    validateSceneBudget(bytes);
    const manager = new THREE.LoadingManager();
    let failedResources = 0;
    manager.onError = () => { failedResources++; };
    manager.setURLModifier(url => {
      if (/^(?:blob:|data:)/.test(url)) return url;
      throw new Error('预览场景包含未内嵌的资源，无法完整显示。');
    });
    gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
    if (failedResources) result.issues.push({ code: 'texture_load_failed', count: failedResources, examples: [] });
    if (signal.aborted || generation !== revision) { disposeGltf(gltf); return; }
    currentScene = result.scene;
    sceneSelect.replaceChildren(...result.scenes.map(name => new Option(name, name, false, name === result.scene)));
    view = createSceneView(gltf);
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.model-toolbar input, .model-toolbar button, .model-toolbar select')
      .forEach(control => { control.disabled = false; });
    showMetadata(result);
    status.hidden = true;
  } catch (error) {
    if (!signal.aborted && generation === revision) {
      view?.dispose();
      if (!view && gltf) disposeGltf(gltf);
      view = null;
      displayError(error);
    }
  } finally {
    if (resource) releaseResource(resource);
    if (activeRequestId === requestId) activeRequestId = null;
  }
}

function validateSceneBudget(bytes: ArrayBuffer) {
  const data = new DataView(bytes);
  if (bytes.byteLength < 20 || data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2) throw new Error('Blender 返回了无效的场景文件。');
  const jsonLength = data.getUint32(12, true);
  if (jsonLength > 8 * 1024 * 1024 || jsonLength + 20 > bytes.byteLength) throw new Error('场景结构过大或不完整。');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  const vertices = (json.meshes ?? []).reduce((total: number, mesh: { primitives: Array<{ attributes: { POSITION: number } }> }) =>
    total + mesh.primitives.reduce((count, primitive) => count + (json.accessors?.[primitive.attributes.POSITION]?.count ?? 0), 0), 0);
  if (vertices > 3_000_000 || (json.nodes?.length ?? 0) > 20_000) throw new Error('场景超过交互预览容量（300 万顶点或 2 万节点），请使用 Blender 查看。');
}

function disposeGltf(gltf: GLTF) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  gltf.scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => { texture.dispose(); if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close(); });
}

function createSceneView(gltf: GLTF) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  const failedSetupCleanup: Array<() => void> = [() => { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); }];
  try {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x181c20);
  renderer.domElement.setAttribute('aria-label', '三维场景画布');
  viewport.prepend(renderer.domElement);
  const world = new THREE.Scene();
  const environmentScene = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(environmentScene);
  failedSetupCleanup.push(() => environment.dispose());
  world.environment = environment.texture;
  environmentScene.dispose();
  pmrem.dispose();
  world.add(gltf.scene, new THREE.HemisphereLight(0xeef5ff, 0x494238, 1.8));
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  failedSetupCleanup.push(() => controls.dispose());
  controls.enableDamping = false;
  const box = new THREE.Box3().setFromObject(gltf.scene);
  if (box.isEmpty()) { box.min.set(-1, -1, -1); box.max.set(1, 1, 1); }
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
  if (!Number.isFinite(radius)) throw new Error('场景包含无效的几何坐标，无法显示。');
  const grid = new THREE.GridHelper(radius * 4, 20, 0x58616a, 0x303942);
  grid.position.set(center.x, box.min.y, center.z);
  world.add(grid);
  let disposed = false;
  let animationFrame = 0;
  let playing = false;
  let previousTime = 0;
  const mixer = new THREE.AnimationMixer(gltf.scene);
  let action: THREE.AnimationAction | null = null;
  const draw = () => {
    if (disposed) return;
    try { renderer.render(world, camera); } catch (error) { setPlaying(false); displayError(error); }
  };
  const resize = () => {
    if (disposed || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;
    camera.aspect = viewport.clientWidth / viewport.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewport.clientWidth, viewport.clientHeight, false);
    draw();
  };
  const fit = (direction = new THREE.Vector3(1, 0.7, 1)) => {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = radius / Math.sin(Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * camera.aspect))) * 1.15;
    camera.near = Math.max(radius / 1000, 0.0001);
    camera.far = Math.max(radius * 100, distance * 10);
    camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    draw();
  };
  const animate = (now: number) => {
    animationFrame = 0;
    if (disposed || !playing || document.hidden) return;
    mixer.update(previousTime ? Math.min((now - previousTime) / 1000, 0.1) : 0);
    previousTime = now;
    timeline.value = String(action?.time ?? 0);
    element('time').textContent = `${(action?.time ?? 0).toFixed(2)} s`;
    draw();
    animationFrame = requestAnimationFrame(animate);
  };
  const setPlaying = (value: boolean) => {
    playing = value;
    element('play').textContent = value ? '暂停' : '播放';
    cancelAnimationFrame(animationFrame);
    previousTime = 0;
    if (value && !document.hidden) animationFrame = requestAnimationFrame(animate);
  };
  const chooseAnimation = () => {
    mixer.stopAllAction();
    const clip = gltf.animations[Number(animationSelect.value)];
    action = clip ? mixer.clipAction(clip) : null;
    action?.reset().play();
    timeline.max = String(clip?.duration ?? 1);
    timeline.value = '0';
    mixer.setTime(0);
    element('time').textContent = '0.00 s';
    draw();
  };
  const visibility = () => setPlaying(playing);
  const contextLost = (event: Event) => {
    event.preventDefault();
    setPlaying(false);
    displayError(new Error('三维显示上下文已中断，请重试此预览。'));
  };
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  document.addEventListener('visibilitychange', visibility);
  failedSetupCleanup.push(() => { document.removeEventListener('visibilitychange', visibility); cancelAnimationFrame(animationFrame); });
  controls.addEventListener('change', draw);
  const observer = new ResizeObserver(resize);
  failedSetupCleanup.push(() => observer.disconnect());
  observer.observe(viewport);
  resize(); fit();
  element('fit').onclick = () => fit();
  element('front').onclick = () => fit(new THREE.Vector3(0, 0, 1));
  element('top').onclick = () => fit(new THREE.Vector3(0, 1, 0.001));
  element<HTMLInputElement>('grid').onchange = event => { grid.visible = (event.target as HTMLInputElement).checked; draw(); };
  grid.visible = element<HTMLInputElement>('grid').checked;
  const wireframe = () => {
    const enabled = element<HTMLInputElement>('wireframe').checked;
    gltf.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
        if ('wireframe' in material) material.wireframe = enabled;
      }
    });
    draw();
  };
  element<HTMLInputElement>('wireframe').onchange = wireframe;
  wireframe();
  animationSelect.replaceChildren(...gltf.animations.map((clip, index) => new Option(clip.name || `动画 ${index + 1}`, String(index))));
  element('animation-controls').hidden = gltf.animations.length === 0;
  animationSelect.onchange = chooseAnimation;
  element('play').onclick = () => setPlaying(!playing);
  timeline.oninput = () => {
    setPlaying(false);
    mixer.setTime(Number(timeline.value));
    element('time').textContent = `${Number(timeline.value).toFixed(2)} s`;
    draw();
  };
  if (gltf.animations.length) chooseAnimation();
  const objects: THREE.Object3D[] = [];
  gltf.scene.traverse(object => { if ((object as THREE.Mesh).isMesh || (object as THREE.Light).isLight) objects.push(object); });
  element('object-count').textContent = `(${objects.length})`;
  element('objects').replaceChildren(...objects.slice(0, 500).map(object => {
    const label = document.createElement('label');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox'; toggle.checked = object.visible;
    toggle.onchange = () => { object.visible = toggle.checked; draw(); };
    label.append(toggle, document.createTextNode(object.name || object.type));
    return label;
  }));
  if (objects.length > 500) element('objects').append('仅列出前 500 个对象，其余仍在场景中显示。');
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(animationFrame);
      document.removeEventListener('visibilitychange', visibility);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      observer.disconnect(); controls.dispose(); mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
      for (const id of ['fit', 'front', 'top', 'play']) element(id).onclick = null;
      element<HTMLInputElement>('grid').onchange = null;
      element<HTMLInputElement>('wireframe').onchange = null;
      animationSelect.onchange = null; timeline.oninput = null;
      disposeGltf(gltf); grid.geometry.dispose();
      for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
      environment.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
  } catch (error) {
    for (const cleanup of failedSetupCleanup.reverse()) { try { cleanup(); } catch { /* Continue releasing remaining preview resources. */ } }
    throw error;
  }
}

function showMetadata(metadata: ModelPreviewMetadata) {
  element('summary').textContent = `${metadata.objects} 个对象 · ${metadata.materials} 个材质`;
  const info = element('info');
  info.replaceChildren();
  const text = (value: string) => { const p = document.createElement('p'); p.textContent = value; info.append(p); };
  text(`Blender ${metadata.blenderVersion} · ${metadata.scene} · ${metadata.frameStart}–${metadata.frameEnd} 帧 · ${metadata.fps.toFixed(2)} fps`);
  text('仅查看临时转换的场景；原文件未修改。几何体、可转换的材质、灯光和动画按 glTF 能力展示，与 Blender 最终渲染可能不同。');
  const labels: Record<string, string> = {
    unsupported_objects: '体积、蜡笔或点云等对象无法完整转换', simulations: '模拟、粒子等效果无法完整还原',
    procedural_materials: '程序化纹理可能简化', missing_images: '存在缺失的外部贴图',
    scripts_disabled: '文件内脚本和 Python 驱动未执行', unapplied_modifiers: '为保留形态键，部分修改器未应用',
    texture_load_failed: '部分内嵌贴图加载失败，相关材质已简化',
  };
  for (const issue of metadata.issues) text(`${labels[issue.code] ?? issue.code}（${issue.count}）：${issue.examples.join('、')}`);
  if (metadata.issues.length) element<HTMLDetailsElement>('info-panel').open = true;
}

sceneSelect.onchange = () => { void loadScene(sceneSelect.value); };
element('retry').onclick = () => { void loadScene(currentScene); };
addEventListener('beforeunload', () => { ++revision; cancelRequest(); view?.dispose(); });
void loadScene();
