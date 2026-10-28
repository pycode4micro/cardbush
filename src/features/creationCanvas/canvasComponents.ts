import { uiText } from '../../i18n';
import type { CanvasItem, CanvasSnapshot } from '@cardbush/bush-protocol';
import { getComponents, saveComponents } from '../components/componentStore';
import { isBuiltinComponent, maxComponentBytes, type HtmlComponent } from '../components/componentModel';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
async function componentHtml(item: CanvasItem): Promise<string> {
  if (item.kind === 'html') return item.html;
  const element = document.querySelector<HTMLElement>(`[data-canvas-item="${CSS.escape(item.id)}"] .canvas-item-content`);
  if (!element) throw Error(uiText()('canvasComponents.make_the_content_visible_on_the_canvas'));
  if (item.kind === 'markdown') return `<style>body{margin:20px;line-height:1.7}img{max-width:100%}pre{overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #666;padding:6px}</style>${element.querySelector('.canvas-markdown')?.innerHTML || escape(item.markdown)}`;
  const rect = element.getBoundingClientRect();
  if (rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) throw Error(uiText()('canvasComponents.fit_the_canvas_before_capturing_a_component'));
  const capture = window.cardbushDesktop?.captureInspectorRegion;
  if (!capture) throw Error(uiText()('canvasComponents.snapshot_capture_is_unavailable'));
  const png = await capture({ rect: { x: rect.x / innerWidth, y: rect.y / innerHeight, width: rect.width / innerWidth, height: rect.height / innerHeight } });
  const image = new Image(); image.src = png; await image.decode();
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 900 / image.width); canvas.width = Math.max(1, image.width * scale); canvas.height = Math.max(1, image.height * scale);
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL('image/jpeg', .7);
  return `<style>body{margin:0}img{display:block;width:100%;height:100vh;object-fit:contain}</style><img alt="${escape(uiText()('canvasComponents.title_canvas_snapshot', { title: item.title }))}" src="${data}">`;
}
export async function extractCanvasComponents(snapshot: CanvasSnapshot, selectedId?: string, welcome = false) {
  const selected = welcome ? snapshot.document.items : snapshot.document.items.filter(item => item.id === selectedId);
  if (!selected.length) throw Error(uiText()('canvasComponents.select_content_to_extract_first'));
  const previous = getComponents();
  if (previous.items.filter(item => !isBuiltinComponent(item)).length + selected.length > 12) throw Error(uiText()('canvasComponents.the_component_library_holds_12_custom_components'));
  const items: HtmlComponent[] = [];
  for (const item of selected) {
    const html = await componentHtml(item);
    if (new TextEncoder().encode(html).length > maxComponentBytes) throw Error(uiText()('canvasComponents.extract_a_smaller_region_this_component_exceeds'));
    items.push({ id: crypto.randomUUID(), title: item.title || snapshot.document.title || uiText()('canvasComponents.canvas'), html, allowActions: false,
      width: Math.max(3, Math.min(12, Math.round(item.frame.width / snapshot.document.width * 12))), height: Math.min(1200, item.frame.height), order: previous.items.length + items.length });
  }
  const placements = items.map((component, index) => { const f = selected[index].frame; return { componentId: component.id, x: f.x / snapshot.document.width * 100, y: f.y, width: f.width / snapshot.document.width * 100, height: f.height }; });
  saveComponents({ ...previous, items: [...previous.items, ...items], ...(welcome ? { welcomeLayout: { viewportHeight: snapshot.document.height + 200, items: [...placements, { componentId: 'system-input', x: 15, y: snapshot.document.height, width: 70, height: 180, composerDock: 'bottom' as const }] } } : {}) }, previous.revision);
  return selected.some(item => item.kind === 'file');
}
