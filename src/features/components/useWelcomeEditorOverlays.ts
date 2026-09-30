import { useLayoutEffect, useState, type RefObject } from 'react';
import { layoutPoint, layoutSpace, type LayoutPoint } from './welcomeLayoutGeometry';

type Rect = LayoutPoint & { width: number; height: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min, max), value));
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** Float the editor's controls within the visible canvas without moving saved components. */
export function useWelcomeEditorOverlays({ root, canvas, toolbar, preferred, drag, layout, refreshKey, menuOpen }: {
  root: RefObject<HTMLDivElement | null>; canvas: RefObject<HTMLDivElement | null>; toolbar: RefObject<HTMLDivElement | null>;
  preferred: LayoutPoint | null; drag: RefObject<unknown>; layout: unknown; refreshKey: number; menuOpen: boolean;
}) {
  const [automatic, setAutomatic] = useState<LayoutPoint | null>(null);
  useLayoutEffect(() => {
    const editor = root.current, page = canvas.current, bar = toolbar.current;
    if (!editor || !page || !bar) return;
    const slots = [...page.querySelectorAll<HTMLElement>('[data-welcome-component]')];
    const measure = () => {
      const space = layoutSpace(editor);
      const rect = (element: HTMLElement): Rect => {
        const r = element.getBoundingClientRect();
        return { ...layoutPoint(space, r.left, r.top), width: r.width / space.scaleX, height: r.height / space.scaleY };
      };
      const pageRect = rect(page);
      const frame = { x: pageRect.x + 8, y: pageRect.y + 8, width: page.clientWidth - 16, height: page.clientHeight - 16 };
      let barRect = rect(bar);
      const slotsWithControls = slots.map(slot => ({ slot, bounds: rect(slot), handles: slot.querySelector<HTMLElement>('.welcome-layout-handles') }));
      // Keep manually placed toolbars where the user left them. Automatic bars
      // move only when obstructed, and stay still during a drag or an open menu.
      if (!preferred && !drag.current && !menuOpen) {
        const obstacles = slotsWithControls.map(({ bounds, handles }) => ({ ...bounds,
          y: bounds.y - (handles?.offsetHeight ?? 24) - 8,
          height: bounds.height + 2 * ((handles?.offsetHeight ?? 24) + 8),
        })).filter(item => overlap(item, frame) > 0);
        const start = { x: clamp(barRect.x, frame.x, frame.x + frame.width - barRect.width),
          y: clamp(barRect.y, frame.y, frame.y + frame.height - barRect.height) };
        const xs = [start.x, frame.x, frame.x + frame.width - barRect.width];
        const ys = [start.y, frame.y, frame.y + frame.height - barRect.height];
        for (const item of obstacles) {
          xs.push(item.x - barRect.width - 8, item.x + item.width + 8);
          ys.push(item.y - barRect.height - 8, item.y + item.height + 8);
        }
        const candidates = ys.flatMap(y => xs.map(x => ({
          x: clamp(x, frame.x, frame.x + frame.width - barRect.width),
          y: clamp(y, frame.y, frame.y + frame.height - barRect.height),
        }))).map(point => ({ point, area: obstacles.reduce((sum, item) => sum + overlap({ ...barRect, ...point }, item), 0),
          distance: Math.hypot(point.x - start.x, point.y - start.y) }));
        candidates.sort((a, b) => a.area - b.area || a.distance - b.distance);
        const next = candidates[0].point;
        setAutomatic(current => current && Math.abs(current.x - next.x) < .5 && Math.abs(current.y - next.y) < .5 ? current : next);
        barRect = { ...barRect, ...next };
      }
      for (const { bounds, handles } of slotsWithControls) {
        if (!handles) continue;
        handles.style.maxWidth = `${Math.max(0, frame.width)}px`;
        const width = handles.offsetWidth, height = handles.offsetHeight;
        const left = clamp(bounds.x, frame.x, frame.x + frame.width - width);
        const above = bounds.y - height - 8, below = bounds.y + bounds.height + 8;
        const top = [above, below].find(y => y >= frame.y && y + height <= frame.y + frame.height
          && overlap({ x: left, y, width, height }, barRect) === 0)
          ?? clamp(above, frame.y, frame.y + frame.height - height);
        handles.style.left = `${left - bounds.x}px`;
        handles.style.top = `${top - bounds.y}px`;
        handles.style.visibility = overlap(bounds, pageRect) > 0 ? '' : 'hidden';
      }
    };
    measure();
    let frame: number | undefined;
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; measure(); }); };
    const observer = new ResizeObserver(schedule);
    for (const element of [editor, page, bar, ...slots, ...slots.flatMap(slot => [...slot.querySelectorAll<HTMLElement>('.welcome-layout-handles')])]) observer.observe(element);
    page.addEventListener('scroll', schedule); window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect(); page.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [root, canvas, toolbar, preferred, automatic, drag, layout, refreshKey, menuOpen]);
  return preferred ?? automatic;
}
