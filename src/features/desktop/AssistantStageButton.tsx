import type { AppLanguage } from '../../types';
import { uiText } from '../../i18n';
import { AssistantStage } from '../assistant/AssistantCharacter';
import { useAssistantActivity } from '../assistant/assistantActivity';
import { useAssistantAvatar } from '../assistant/assistantAvatar';
import { useAssistantActions } from '../assistant/useAssistantActions';
import { useSidebarContextMenu } from '../sidebar/SidebarContextMenu';

export function AssistantStageButton({ language, active, onOpen }: {
  language: AppLanguage; active: boolean; onOpen(): void;
}) {
  const assistant = useAssistantActions(language);
  const { menu, openContextMenu } = useSidebarContextMenu();
  const activity = useAssistantActivity();
  const avatar = useAssistantAvatar();
  const t = uiText(language);
  const label = t('assistantActivity.open', { name: assistant.profile.name, status: t(`assistantActivity.${activity}`) });
  return <>
    <button className="sidebar-assistant" type="button" data-nav-section="assistant"
      aria-current={active ? 'page' : undefined} aria-label={label} title={label}
      onClick={onOpen} onContextMenu={event => openContextMenu(event, 'nav:assistant', assistant.items)}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openContextMenu(event, 'nav:assistant', assistant.items);
      }}>
      <AssistantStage state={activity} avatar={avatar}/>
      <span className="sidebar-assistant-name">{assistant.profile.name}</span>
    </button>
    {menu}
    {assistant.dialog}
  </>;
}
