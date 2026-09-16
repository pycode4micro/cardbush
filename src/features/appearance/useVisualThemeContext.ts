import { useEffect } from 'react';
import { visualThemeTokens, type VisualThemeContext } from '../../../electron/visualThemeContextSchema';

/** Publish actual computed appearance, including custom palettes, for Skills. */
export function useVisualThemeContext(theme: VisualThemeContext['theme'], preference: VisualThemeContext['preference']) {
  useEffect(() => {
    const app = document.querySelector('.app');
    const publish = window.cardbushDesktop?.publishVisualTheme;
    if (!app || !publish) return;
    let previous = '';
    let disposed = false;
    const update = () => {
      const style = getComputedStyle(app);
      // Settings can temporarily replace the chat. Its surface token still
      // describes the conversation canvas, unlike the sidebar's app backdrop.
      let background = style.getPropertyValue('--surface').trim() || style.backgroundColor;
      for (let surface: Element | null = document.querySelector('.message-list, .main-stage'); surface; surface = surface.parentElement) {
        const color = getComputedStyle(surface).backgroundColor;
        if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { background = color; break; }
      }
      const context: VisualThemeContext = {
        theme, preference,
        colorScheme: style.colorScheme.split(' ').includes('dark') ? 'dark' : 'light',
        background,
        fontFamily: style.fontFamily,
        tokens: Object.fromEntries(visualThemeTokens.map(token => [token, style.getPropertyValue(token).trim()])) as VisualThemeContext['tokens'],
      };
      const serialized = JSON.stringify(context);
      if (previous === serialized || disposed) return;
      previous = serialized;
      void publish(context).catch(() => { if (!disposed) previous = ''; });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(app, { attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('focus', update);
    return () => { disposed = true; observer.disconnect(); window.removeEventListener('focus', update); };
  }, [theme, preference]);
}
