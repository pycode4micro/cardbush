import { Ellipsis } from 'lucide-react';
import { useContext, useLayoutEffect, useRef } from 'react';
import { HoverPreview, useHoverPreview } from '../../components/HoverPreview';
import { uiText } from '../../i18n';
import { ApplicationIcon } from '../appCenter/AppCenter';
import { applicationReference } from '../appCenter/appCenterModel';
import { requestApplication, useApplications } from '../appCenter/appCenterStore';
import { ConversationHostContext } from '../conversationHost';

export function SidebarApplications({ language }: { language: string }) {
  const label = uiText(language)('sidebar.moreApps');
  const preview = useHoverPreview(false, { interactive: true });
  const apps = useApplications(language, Boolean(preview.anchor));
  const host = useContext(ConversationHostContext);
  const list = useRef<HTMLDivElement>(null), focusOnOpen = useRef(false);
  useLayoutEffect(() => {
    if (preview.anchor && focusOnOpen.current) {
      list.current?.querySelector('button')?.focus({ preventScroll: true });
      focusOnOpen.current = false;
    }
  }, [preview.anchor]);
  const open = (button: HTMLButtonElement, keyboard: boolean) => {
    if (keyboard && preview.anchor) list.current?.querySelector('button')?.focus({ preventScroll: true });
    else { focusOnOpen.current = keyboard; preview.open(button); }
  };
  return <>
    <button type="button" className="nav-row sidebar-more-apps" {...preview.triggerProps}
      aria-label={label} aria-haspopup="dialog" aria-expanded={Boolean(preview.anchor)} aria-controls={preview.anchor ? preview.id : undefined}
      onClick={event => open(event.currentTarget, event.detail === 0)}
      onKeyDown={event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); open(event.currentTarget, true); }
      }}>
      <span className="nav-row-icon" aria-hidden="true"><Ellipsis/></span><span>{label}</span>
    </button>
    <HoverPreview preview={preview} className="sidebar-app-flyout" interactiveLabel={label}>
      <div ref={list} className="sidebar-app-list" onKeyDown={event => {
        if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
        {apps.map(app => <button key={app.id} type="button" data-sidebar-app={app.id} onClick={() => {
          preview.dismiss(); requestApplication(app.id, host?.environmentId, applicationReference(app));
        }}><span aria-hidden="true"><ApplicationIcon app={app}/></span><span>{app.title}</span></button>)}
      </div>
    </HoverPreview>
  </>;
}
