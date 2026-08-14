import { useEffect, useState } from 'react';

export type SoftPanelPresence = {
  mounted: boolean;
  visible: boolean;
};

export function useSoftPanelPresence(
  open: boolean,
  exitDurationMs = 240,
): SoftPanelPresence {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let mountFrame = 0;
    let revealFrame = 0;
    let timer = 0;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (open) {
      setVisible(false);
      setMounted(true);
      mountFrame = window.requestAnimationFrame(() => {
        revealFrame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timer = window.setTimeout(
        () => setMounted(false),
        reduceMotion ? 0 : exitDurationMs,
      );
    }
    return () => {
      window.cancelAnimationFrame(mountFrame);
      window.cancelAnimationFrame(revealFrame);
      window.clearTimeout(timer);
    };
  }, [exitDurationMs, open]);

  return { mounted, visible };
}
