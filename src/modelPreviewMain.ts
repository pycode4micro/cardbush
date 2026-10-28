import { htmlText } from './i18n/htmlText';
import { uiText, resolveUiLanguage } from './i18n';
import type { SceneView } from './features/modelPreview/sceneView';
import type { ModelPreviewMetadata } from '../electron/modelPreview';
import './styles/modelPreview.css';

const root = document.getElementById('model-preview-root')!;
const parameters = new URLSearchParams(location.search);
const language = resolveUiLanguage(parameters.get('lang') ?? navigator.language);
document.documentElement.lang = language;
const filePath = parameters.get('path') ?? '';
const fileName = filePath.split(/[\\/]/).at(-1) ?? filePath;
document.title = uiText(language)('modelPreviewMain.value1_blender_read_only_preview', { value1: fileName });
root.innerHTML = `
  <header><strong id="file-name"></strong><span class="readonly">${htmlText(uiText(language)('messageBubble.readOnly'))}</span></header>
  <div class="model-toolbar" role="toolbar" aria-label="${htmlText(uiText(language)('modelPreviewMain.3d_viewing_tools'))}">
    <select id="scenes" aria-label="${htmlText(uiText(language)('modelPreviewMain.scene'))}" disabled></select>
    <button id="fit" disabled>${htmlText(uiText(language)('image.resetHint'))}</button><button id="front" disabled>${htmlText(uiText(language)('modelPreviewMain.front_view'))}</button><button id="top" disabled>${htmlText(uiText(language)('modelPreviewMain.top_view'))}</button>
    <label><input id="wireframe" type="checkbox" disabled>${htmlText(uiText(language)('modelPreviewMain.wireframe'))}</label><label><input id="grid" type="checkbox" checked disabled>${htmlText(uiText(language)('modelPreviewMain.grid'))}</label>
  </div>
  <main id="viewport" aria-label="${htmlText(uiText(language)('modelPreviewMain.read_only_3d_scene'))}"><div id="status" role="status">${htmlText(uiText(language)('modelPreviewMain.preparing_the_scene_with_blender'))}</div></main>
  <section id="error" role="alert" hidden><strong>${htmlText(uiText(language)('modelPreviewMain.could_not_display_the_3d_preview'))}</strong><p></p><button id="retry">${htmlText(uiText(language)('inspectorErrorBoundary.retryPreview'))}</button></section>
  <div id="animation-controls" hidden>
    <select id="animations" aria-label="${htmlText(uiText(language)('modelPreviewMain.animation'))}"></select><button id="play">${htmlText(uiText(language)('modelPreviewMain.play'))}</button>
    <input id="timeline" type="range" aria-label="${htmlText(uiText(language)('modelPreviewMain.animation_progress'))}" min="0" max="1" step="0.01" value="0"><output id="time">0.00 s</output>
  </div>
  <footer><span id="summary"></span><span>${htmlText(uiText(language)('modelPreviewMain.drag_to_rotate_scroll_to_zoom_right'))}</span></footer>
  <details id="objects-panel"><summary>${htmlText(uiText(language)('modelPreviewMain.scene_objects'))}<span id="object-count"></span></summary><div id="objects"></div></details>
  <details id="info-panel"><summary>${htmlText(uiText(language)('modelPreviewMain.file_information_and_preview_scope'))}</summary><div id="info"></div></details>`;

function element<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
element('file-name').textContent = fileName;
element('file-name').title = filePath;
const viewport = element('viewport');
const status = element('status');
const errorPanel = element('error');
const sceneSelect = element<HTMLSelectElement>('scenes');
let revision = 0;
let request: AbortController | null = null;
let activeRequestId: string | null = null;
let currentScene = '';
let view: SceneView | null = null;

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
  errorPanel.querySelector('strong')!.textContent = uiText(language)('modelPreviewMain.could_not_display_the_3d_preview');
  status.hidden = false;
  status.textContent = uiText(language)('modelPreviewMain.preparing_the_scene_with_blender');
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.model-toolbar input, .model-toolbar button, .model-toolbar select')
    .forEach(control => { control.disabled = true; });
  element('animation-controls').hidden = true;
  element('objects').replaceChildren();
  element('object-count').textContent = '';
  element('summary').textContent = '';
  element('info').replaceChildren();
  let resource: string | undefined;
  let disposeScene: (() => void) | undefined;
  try {
    const url = new URL('cardbush-file://model-preview/manifest');
    url.searchParams.set('path', filePath);
    url.searchParams.set('requestId', requestId);
    if (scene) url.searchParams.set('scene', scene);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(uiText(language)('modelPreviewMain.could_not_read_the_file_value1', { value1: response.status }));
    const result = await response.json() as ModelPreviewMetadata & { resource: string; size: number; error?: string; code?: string };
    if (result.error) {
      if (result.code === 'blender_missing') {
        errorPanel.classList.add('dependency-missing');
        errorPanel.querySelector('strong')!.textContent = uiText(language)('modelPreviewMain.3d_previews_require_blender');
        throw new Error(uiText(language)('modelPreviewMain.value1_blender_was_not_found_install_it', { value1: filePath }));
      }
      if (result.code === 'timeout') throw new Error(uiText(language)('modelPreviewMain.blender_conversion_exceeded_120_seconds_check_the'));
      if (result.code === 'busy') throw new Error(uiText(language)('modelPreviewMain.other_3d_previews_are_being_prepared_retry'));
      throw new Error(result.error);
    }
    resource = result.resource;
    if (signal.aborted) return;
    status.textContent = uiText(language)('modelPreviewMain.loading_3d_view');
    const bytes = await fetch(resource, { signal }).then(response => {
      if (!response.ok) throw new Error(uiText(language)('modelPreviewMain.the_temporary_preview_expired_retry_the_preview'));
      return response.arrayBuffer();
    });
    validateSceneBudget(bytes);
    // Keep the loading/error shell usable without loading a WebGL engine.
    // Import only after Blender produced a valid scene; failed dependencies and
    // cancelled conversions never initialize the rendering runtime.
    const engine = await import('./features/modelPreview/sceneView');
    if (signal.aborted || generation !== revision) return;
    const { gltf, failedResources } = await engine.readScene(bytes);
    disposeScene = () => engine.disposeGltf(gltf);
    if (failedResources) result.issues.push({ code: 'texture_load_failed', count: failedResources, examples: [] });
    if (signal.aborted || generation !== revision) { disposeScene(); return; }
    currentScene = result.scene;
    sceneSelect.replaceChildren(...result.scenes.map(name => new Option(name, name, false, name === result.scene)));
    view = engine.createSceneView(gltf, { root, viewport, onError: displayError });
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.model-toolbar input, .model-toolbar button, .model-toolbar select')
      .forEach(control => { control.disabled = false; });
    showMetadata(result);
    status.hidden = true;
  } catch (error) {
    if (!signal.aborted && generation === revision) {
      view?.dispose();
      if (!view) disposeScene?.();
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
  if (bytes.byteLength < 20 || data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2) throw new Error(uiText(language)('modelPreviewMain.blender_returned_an_invalid_scene_file'));
  const jsonLength = data.getUint32(12, true);
  if (jsonLength > 8 * 1024 * 1024 || jsonLength + 20 > bytes.byteLength) throw new Error(uiText(language)('modelPreviewMain.the_scene_structure_is_too_large_or'));
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  const vertices = (json.meshes ?? []).reduce((total: number, mesh: { primitives: Array<{ attributes: { POSITION: number } }> }) =>
    total + mesh.primitives.reduce((count, primitive) => count + (json.accessors?.[primitive.attributes.POSITION]?.count ?? 0), 0), 0);
  if (vertices > 3_000_000 || (json.nodes?.length ?? 0) > 20_000) throw new Error(uiText(language)('modelPreviewMain.the_scene_exceeds_the_interactive_preview_limit'));
}

function showMetadata(metadata: ModelPreviewMetadata) {
  element('summary').textContent = uiText(language)('modelPreviewMain.value1_objects_value2_materials', { value1: metadata.objects, value2: metadata.materials });
  const info = element('info');
  info.replaceChildren();
  const text = (value: string) => { const p = document.createElement('p'); p.textContent = value; info.append(p); };
  text(uiText(language)('modelPreviewMain.blender_value1_value2_frames_value3_value4_value5', { value1: metadata.blenderVersion, value2: metadata.scene, value3: metadata.frameStart, value4: metadata.frameEnd, value5: metadata.fps.toFixed(2) }));
  text(uiText(language)('modelPreviewMain.this_is_a_temporary_converted_scene_the'));
  const labels: Record<string, string> = {
    unsupported_objects: uiText(language)('modelPreviewMain.volume_grease_pencil_or_point_cloud_objects'), simulations: uiText(language)('modelPreviewMain.simulations_and_particle_effects_cannot_be_fully'),
    procedural_materials: uiText(language)('modelPreviewMain.procedural_textures_may_be_simplified'), missing_images: uiText(language)('modelPreviewMain.some_external_textures_are_missing'),
    scripts_disabled: uiText(language)('modelPreviewMain.embedded_scripts_and_python_drivers_were_not'), unapplied_modifiers: uiText(language)('modelPreviewMain.some_modifiers_were_not_applied_to_preserve'),
    texture_load_failed: uiText(language)('modelPreviewMain.some_embedded_textures_failed_to_load_affected'),
  };
  for (const issue of metadata.issues) text(`${labels[issue.code] ?? issue.code}（${issue.count}）：${issue.examples.join('、')}`);
  if (metadata.issues.length) element<HTMLDetailsElement>('info-panel').open = true;
}

sceneSelect.onchange = () => { void loadScene(sceneSelect.value); };
element('retry').onclick = () => { void loadScene(currentScene); };
addEventListener('beforeunload', () => { ++revision; cancelRequest(); view?.dispose(); });
void loadScene();
