import { ArrowLeft } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { selectTeam, useTeamWorkspace } from './teamWorkspaceStore';
import { AppCenterDock } from '../appCenter/AppCenter';
import './team-workspace.css';

export function NativeTeamSidebar({ language, onBack, softVisible = true }: { language: AppLanguage; onBack?: () => void; onOpenSettings?: () => void; softVisible?: boolean }) {
  const state = useTeamWorkspace();
  return <aside className={`sidebar native-team-sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}>
    <button type="button" onClick={onBack}><ArrowLeft size={16} />{language === 'zh' ? '返回对话' : 'Back to chats'}</button>
    <h3>Team</h3>
    <p>{language === 'zh' ? '管理员工，在文档中组织协作。' : 'Manage agents and document their collaboration.'}</p>
    {state.choices.map(team => <button type="button" key={team.id} className={state.selectedId === team.id ? 'active' : ''} onClick={() => selectTeam(team.id)}>{team.name}</button>)}
    <div className="native-team-app-dock"><AppCenterDock language={language}/></div>
  </aside>;
}
