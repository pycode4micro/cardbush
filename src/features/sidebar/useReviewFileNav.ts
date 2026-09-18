import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';

const widthKey = 'cardbush.review_file_nav_width';
const collapsedKey = 'cardbush.review_file_nav_collapsed';
const minimumWidth = 150;
const maximumWidth = 420;
// The file list is narrower than the main sidebars; keep a usable narrow list
// before snapping it closed near the review panel's right edge.
const collapseWidth = 80;

function readSetting(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function saveSetting(key: string, value: number | boolean) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* Keep the current layout usable. */ }
}

export function useReviewFileNav() {
  const [width, setWidth] = useState(() => {
    const stored = Number.parseFloat(readSetting(widthKey) ?? '');
    return Number.isFinite(stored) ? Math.min(maximumWidth, Math.max(minimumWidth, stored)) : 210;
  });
  const [collapsed, setCollapsed] = useState(() => readSetting(collapsedKey) === 'true');
  const presence = useSoftPanelPresence(!collapsed);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);
  useLayoutEffect(() => {
    // Keep the transient drag width throughout a snap's exit, then restore the
    // saved width before revealing the list (also when reopening mid-exit).
    if (!collapsed && !cancelRef.current) {
      workspaceRef.current?.style.setProperty('--change-file-nav-width', `${width}px`);
    }
  }, [collapsed, width]);
  const changeCollapsed = useCallback((value: boolean) => {
    cancelRef.current?.();
    setCollapsed(value);
    saveSetting(collapsedKey, value);
  }, []);
  const commitWidth = useCallback((value: number) => {
    setWidth(value);
    saveSetting(widthKey, value);
  }, []);
  const beginResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || collapsed || !presence.visible) return;
    cancelRef.current?.();
    const handle = event.currentTarget;
    const workspace = handle.closest<HTMLElement>('.change-review-workspace');
    const nav = workspace?.querySelector<HTMLElement>('.change-review-file-nav-viewport');
    if (!workspace || !nav) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = nav.getBoundingClientRect().width;
    const previousWidth = workspace.style.getPropertyValue('--change-file-nav-width');
    let nextWidth = startWidth;
    let frame = 0;
    const preview = (value: number) => {
      workspace.style.setProperty('--change-file-nav-width', `${value}px`);
      handle.setAttribute('aria-valuenow', String(Math.round(value)));
    };
    const finish = (restore = false) => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', abort);
      window.removeEventListener('resize', abort);
      handle.removeEventListener('lostpointercapture', cancel);
      cancelRef.current = null;
      if (restore) {
        workspace.style.setProperty('--change-file-nav-width', previousWidth);
        handle.setAttribute('aria-valuenow', String(width));
        nav.getBoundingClientRect();
      }
      document.body.classList.remove('change-review-resizing');
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      nextWidth = Math.max(0, Math.min(navMaximum(workspace), startWidth + startX - moveEvent.clientX));
      if (nextWidth < collapseWidth && nextWidth < startWidth) {
        preview(nextWidth);
        // Commit the pointer's final position while resize transitions are off;
        // the shared presence animation can then continue from that width.
        nav.getBoundingClientRect();
        finish();
        changeCollapsed(true);
        return;
      }
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; preview(nextWidth); });
    };
    const up = (upEvent: globalThis.PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      const value = Math.max(minimumWidth, Math.round(nextWidth));
      finish();
      preview(value);
      commitWidth(value);
    };
    const cancel = (cancelEvent: globalThis.PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) finish(true);
    };
    const abort = () => finish(true);
    handle.setPointerCapture(pointerId);
    document.body.classList.add('change-review-resizing');
    cancelRef.current = abort;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', abort);
    window.addEventListener('resize', abort);
    handle.addEventListener('lostpointercapture', cancel);
  }, [collapsed, presence.visible, width, changeCollapsed, commitWidth]);
  const resizeWithKeyboard = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const workspace = event.currentTarget.closest<HTMLElement>('.change-review-workspace');
    if (!workspace || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home' || event.key === 'Enter') { changeCollapsed(true); return true; }
    const current = workspace.querySelector('.change-review-file-nav')?.getBoundingClientRect().width ?? width;
    const next = event.key === 'End' ? navMaximum(workspace) : current + (event.key === 'ArrowLeft' ? 24 : -24);
    if (next < minimumWidth) { changeCollapsed(true); return true; }
    commitWidth(Math.min(navMaximum(workspace), next));
    return false;
  }, [changeCollapsed, commitWidth, width]);
  return { width, collapsed, presence, workspaceRef, changeCollapsed, beginResize, resizeWithKeyboard };
}

function navMaximum(workspace: HTMLElement) {
  const available = workspace.getBoundingClientRect().width;
  return Math.max(minimumWidth, Math.min(maximumWidth, available * 0.48, available - 260));
}
