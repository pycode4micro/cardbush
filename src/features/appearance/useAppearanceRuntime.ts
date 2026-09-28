import { useEffect } from 'react';
import { resolveReducedMotion, type AppearancePreferences } from './appearancePreferences';

export function useAppearanceRuntime(preferences: AppearancePreferences) {
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      document.documentElement.dataset.motionPreference = preferences.reducedMotion;
      document.documentElement.dataset.reduceMotion = String(resolveReducedMotion(preferences.reducedMotion, media.matches));
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preferences.reducedMotion]);
}
