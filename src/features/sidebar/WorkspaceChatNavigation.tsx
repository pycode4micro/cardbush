import { Folder, SquarePen } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { uiText } from '../../i18n';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { useSidebarContextMenu } from './SidebarContextMenu';
import { SidebarNavRow } from './SidebarNavRow';

export function WorkspaceChatNavigation({ language, projectsActive, onProjects, onNewChat }: {
  language: AppLanguage; projectsActive: boolean; onProjects(): void; onNewChat(): void;
}) {
  const t = uiText(language);
  const { menu, openContextMenu } = useSidebarContextMenu();
  const shortcuts = useKeyboardShortcuts();
  const newChat = t('conversationSearchDialog.newChat');
  return <>
    <SidebarNavRow navSection="chat" shortcut="newConversation" ariaKeyShortcuts={shortcuts.aria('newConversation')}
      label={newChat} icon={<SquarePen/>} onClick={onNewChat}
      onContextMenu={event => openContextMenu(event, 'nav:new-chat', [
        { key: 'new-chat', icon: <SquarePen/>, label: t('chatSidebar.newChat'), onClick: onNewChat },
      ])}/>
    <SidebarNavRow navSection="projects" label={t('archivedItemsPanel.projects')} icon={<Folder/>}
      active={projectsActive} onClick={onProjects}/>
    {menu}
  </>;
}
