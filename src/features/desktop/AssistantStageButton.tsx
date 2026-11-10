import type { AppLanguage, ThemeMode } from '../../types';
import { uiText } from '../../i18n';
import { AssistantStage } from '../assistant/AssistantCharacter';
import { useAssistantActivity } from '../assistant/assistantActivity';
import { useAssistantAvatar } from '../assistant/assistantAvatar';
import { useAssistantActions } from '../assistant/useAssistantActions';
import { useSidebarContextMenu } from '../sidebar/SidebarContextMenu';

export function AssistantStageButton({ language, theme, active, onOpen }: {
  language: AppLanguage; theme: ThemeMode; active: boolean; onOpen(): void;
}) {
  const assistant = useAssistantActions(language);
  const { menu, openContextMenu } = useSidebarContextMenu();
  const activity = useAssistantActivity();
  const avatar = useAssistantAvatar();
  const t = uiText(language);
  const status = t(`assistantActivity.${activity}`);
  return <>
    <button className="recent-bar-chat no-drag" type="button" data-nav-section="assistant"
      aria-current={active ? 'page' : undefined} aria-label={t('assistantActivity.open', { name: assistant.profile.name, status })}
      onClick={onOpen} onContextMenu={event => openContextMenu(event, 'nav:assistant', assistant.items)}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openContextMenu(event, 'nav:assistant', assistant.items);
      }}>
      <AssistantStage state={activity} avatar={avatar} theme={theme}/>
      <span className="recent-chat-copy"><strong>{assistant.profile.name}</strong><small>{status}</small></span>
    </button>
    {menu}
    {assistant.dialog}
  </>;
}
