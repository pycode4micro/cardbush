import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export type SceneView = { dispose(): void };

export async function readScene(bytes: ArrayBuffer) {
  const manager = new THREE.LoadingManager();
  let failedResources = 0;
  manager.onError = () => { failedResources++; };
  manager.setURLModifier(url => {
    if (/^(?:blob:|data:)/.test(url)) return url;
    throw new Error('预览场景包含未内嵌的资源，无法完整显示。');
  });
  const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
  return { gltf, failedResources };
}

export function disposeGltf(gltf: GLTF) {
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

export function createSceneView(gltf: GLTF, { root, viewport, onError: displayError }: {
  root: HTMLElement; viewport: HTMLElement; onError: (error: unknown) => void;
}): SceneView {
  const element = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const animationSelect = element<HTMLSelectElement>('animations');
  const timeline = element<HTMLInputElement>('timeline');
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
