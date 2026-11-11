import { RecentConversationBar } from '../../src/features/desktop/RecentConversationBar';
import { WindowConversationBar } from '../../src/features/desktop/WindowConversationBar';
import { WindowFrame } from '../../src/components/WindowFrame';
import '../../src/styles/shell.css';
export { setAssistantActivity } from '../../src/features/assistant/assistantActivity';
import '../../src/features/desktop/recentConversationBar.css';

export function VoiceStageFixture({ language, running, viewingConversation = false, open }: { language: string; running: boolean; viewingConversation?: boolean; open(id: string, call?: boolean): void }) {
  return <>
    <WindowFrame language={language} sidebarCollapsed menus={[]} onError={error => { throw error; }}>
      <WindowConversationBar language={language} assistantName="Assistant" open={open} viewingConversation={viewingConversation}
        conversation={{ id: 'chat', title: 'Fixture chat', status: running ? 'Working' : undefined }}/>
    </WindowFrame>
    <RecentConversationBar language={language} assistantName="Assistant" selectedId="chat" conversations={[]}
      notices={[]} openNotice={() => {}} onRecentList={() => {}} open={open}/>
  </>;
}
