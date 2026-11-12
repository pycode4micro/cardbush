import { Activity, createContext, memo, useState, type ReactNode } from 'react';
import type { AppSection } from '../../types';
import { PageNavigationScope } from './PageNavigation';

export const FeaturePageVisible = createContext(true);
type FeatureSection = Exclude<AppSection, 'home' | 'explore' | 'assistant' | 'chat'>;
type RenderPage = (section: FeatureSection) => ReactNode;
const FeaturePage = memo(function FeaturePage({section, visible, render}: {section: FeatureSection; visible: boolean; render: RenderPage}) {
  return <Activity mode={visible ? 'visible' : 'hidden'}>
    <FeaturePageVisible.Provider value={visible}>
      <PageNavigationScope.Provider value={`main:${section}`}>{render(section)}</PageNavigationScope.Provider>
    </FeaturePageVisible.Provider>
  </Activity>;
}, (previous, next) => !previous.visible && !next.visible);

/** A fixed desktop section mounts on first visit. Activity disconnects effects while it is away. */
export function VisitedFeaturePages({ current, children }: { current?: FeatureSection; children: RenderPage }) {
  const [visited, setVisited] = useState<FeatureSection[]>([]);
  if (current && !visited.includes(current)) setVisited([...visited, current]);
  return visited.map(section => <FeaturePage key={section} section={section} visible={section === current} render={children}/>);
}
