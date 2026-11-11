import { AssistantStageButton } from '../../src/features/desktop/AssistantStageButton';
import '../../src/features/desktop/recentConversationBar.css';

export function VoiceStageFixture({ language, returnToCall = () => {} }: { language: string; returnToCall?(id: string): void }) {
  return <header className="recent-bar" style={{ height: 50 }}>
    <AssistantStageButton language={language} active={false} onOpen={() => {}} onReturnToCall={returnToCall}/>
  </header>;
}
