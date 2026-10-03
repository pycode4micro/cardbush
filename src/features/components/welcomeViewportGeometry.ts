import type { WelcomeLayout } from './componentModel';

// Horizontal placements already use percentages. Keep the vertical design in
// the same coordinate space, measured against the visible pane, never its
// scrollHeight (which includes the placements themselves).
export function welcomeHeightScale(referenceHeight: number | undefined, viewportHeight: number) {
  return referenceHeight && referenceHeight > 0 && viewportHeight > 0 ? viewportHeight / referenceHeight : 1;
}

export function resolveWelcomeLayout(layout: WelcomeLayout, viewportHeight: number): WelcomeLayout {
  const scale = welcomeHeightScale(layout.viewportHeight, viewportHeight);
  return { viewportHeight, items: layout.items.map(item => ({ ...item, y: item.y * scale,
    // The composer is measured from its live content rather than stretched.
    height: item.componentId === 'system-input' ? item.height : item.height * scale })) };
}
