import { Edit3, Folder, LoaderCircle, MicOff, VolumeX } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { uiText } from '../../i18n';
import { AssistantBulb } from '../assistant/AssistantBulb';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { useAssistantActions } from '../assistant/useAssistantActions';
import { useSidebarContextMenu } from '../sidebar/SidebarContextMenu';

export function WorkspaceChatNavigation({ language, assistantActive, projectsActive, onProjects, onNewChat, onAssistant }: {
  language: AppLanguage; assistantActive: boolean; projectsActive: boolean; onProjects(): void; onNewChat(): void; onAssistant(): void;
}) {
  const t = uiText(language);
  const assistant = useAssistantActions(language);
  const { menu, openContextMenu } = useSidebarContextMenu();
  const shortcuts = useKeyboardShortcuts();
  const newChat = t('conversationSearchDialog.newChat');
  return <>
    <div className="workspace-chat-navigation">
      <button type="button" className="no-drag" data-nav-section="chat" data-shortcut="newConversation" aria-keyshortcuts={shortcuts.aria('newConversation')}
        aria-label={newChat} title={newChat} onClick={onNewChat}
        onContextMenu={event => openContextMenu(event, 'nav:new-chat', [
          { key: 'new-chat', icon: <Edit3/>, label: t('chatSidebar.newChat'), onClick: onNewChat },
        ])}>
        <Edit3 aria-hidden="true"/>
      </button>
      <button type="button" className="no-drag" data-nav-section="projects" aria-label={t('archivedItemsPanel.projects')}
        aria-current={projectsActive ? 'page' : undefined} title={t('archivedItemsPanel.projects')} onClick={onProjects}>
        <Folder aria-hidden="true"/>
      </button>
      <button type="button" className="no-drag" data-nav-section="assistant" aria-label={assistant.profile.name}
        aria-current={assistantActive ? 'page' : undefined} title={assistant.profile.name} onClick={onAssistant}
        onContextMenu={event => openContextMenu(event, 'nav:assistant', assistant.items)}>
        <AssistantBulb/>
        {assistant.resetting && <LoaderCircle className="workspace-chat-status spin" aria-hidden="true"/>}
        {assistant.profile.microphoneMuted && <MicOff className="workspace-chat-status" aria-label={t('chatSidebar.microphoneMuted')}/>}
        {assistant.profile.outputMuted && <VolumeX className="workspace-chat-status" aria-label={t('chatSidebar.speechMuted')}/>}
      </button>
    </div>
    {menu}
    {assistant.dialog}
  </>;
}
