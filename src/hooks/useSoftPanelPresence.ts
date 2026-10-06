import { prefersReducedMotion } from '../shared/motionPreference';
import { useEffect, useState } from 'react';

export type SoftPanelPresence = {
  mounted: boolean;
  visible: boolean;
};

export function useSoftPanelPresence(
  open: boolean,
  exitDurationMs = 240,
  { keepMounted = false }: { keepMounted?: boolean } = {},
): SoftPanelPresence {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let mountFrame = 0;
    let revealFrame = 0;
    let timer = 0;
    const reduceMotion = prefersReducedMotion();
    if (open) {
      // The initial open state is already laid out. Replaying an entrance here
      // briefly hides the startup sidebar, including under StrictMode.
      if (visible) return;
      if (reduceMotion) {
        setMounted(true);
        setVisible(true);
        return;
      }
      setVisible(false);
      setMounted(true);
      mountFrame = window.requestAnimationFrame(() => {
        revealFrame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      // Stateful pages (especially native webviews) must survive a collapse.
      // Still mount lazily on first open, and let actual tab removal dispose them.
      if (!keepMounted) {
        timer = window.setTimeout(
          () => setMounted(false),
          reduceMotion ? 0 : exitDurationMs,
        );
      }
    }
    return () => {
      window.cancelAnimationFrame(mountFrame);
      window.cancelAnimationFrame(revealFrame);
      window.clearTimeout(timer);
    };
  }, [exitDurationMs, open, keepMounted]);

  return { mounted, visible };
}
