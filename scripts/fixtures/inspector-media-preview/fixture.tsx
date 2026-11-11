import React, { createRef, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InspectorWebview, type InspectorNavigationState, type InspectorWebviewHandle } from '../../../src/features/inspector/InspectorWebview';
import * as targets from '../../../src/features/inspector/inspectorTargets';
import '../../../src/styles/theme.css';
import '../../../src/styles/inspector.css';

const handle = createRef<InspectorWebviewHandle>();
Object.assign(window, { cardbushDesktop: {}, targets, handle, nav: { loading: true } });
function onNavigation(_identity: string, nav: InspectorNavigationState) {
  Object.assign(window, { nav });
}
const onOpenTarget = () => {};

function Fixture() {
  const [target, openMedia] = useState('');
  Object.assign(window, { openMedia });
  return target && <InspectorWebview ref={handle} identity="fixture" target={target}
    source={targets.inspectorSource(target)} language="zh"
    onNavigationStateChange={onNavigation} onOpenTarget={onOpenTarget} />;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
