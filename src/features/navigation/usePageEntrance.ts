import { useLayoutEffect, type RefObject } from 'react';
import { prefersReducedMotion } from '../../shared/motionPreference';
import './pageEntrance.css';

/** Replay the incoming page only. Retained panels keep their focus, scroll position and local state. */
export function usePageEntrance(ref: RefObject<HTMLElement | null>, page: string, active: boolean) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!active || !node || prefersReducedMotion()) return;
    node.dataset.pageEntering = '';
    const entrance = node.getAnimations().find(effect =>
      effect instanceof CSSAnimation && effect.animationName === 'workspace-page-entrance');
    if (!entrance) {
      delete node.dataset.pageEntering;
      return;
    }
    let current = true;
    const finish = () => { if (current) delete node.dataset.pageEntering; };
    entrance.currentTime = 0;
    entrance.play();
    void entrance.finished.then(finish, finish);
    return () => {
      current = false;
      delete node.dataset.pageEntering;
    };
  }, [ref, page, active]);
}
