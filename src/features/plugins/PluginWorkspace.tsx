import { Suspense, useEffect, useState, type ComponentProps } from 'react';
import type { BackendCapabilities } from '../../types';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import { PluginManagementPanel } from './PluginManagementPanel';

// Reuse the existing MCP editor without opening the settings shell. Load it
// only when a server is selected, keeping the catalog entry lightweight.
const McpEditor = recoverableLazy('plugin-mcp-editor', async () => {
  const module = await import('../SettingsView');
  return { default: module.McpServersPanel };
}, (props, retry) => <DeferredModuleNotice language={props.language} retry={retry} />);

type Props = Pick<ComponentProps<typeof PluginManagementPanel>,
  'language' | 'skills' | 'disabledSkillNames' | 'onToggleSkill' | 'onReloadSkills' | 'onLoadSkillDetail' | 'onOpenPrompt'> & {
  capabilities: BackendCapabilities;
};

export function PluginWorkspace({ capabilities, ...props }: Props) {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return <div className="feature-content plugin-workspace-scroll" data-plugin-scroll-container>
    <PluginManagementPanel {...props} initialTab="plugins" onNotify={setNotice}
      renderMcp={serverId => <Suspense fallback={<p role="status">{props.language === 'zh' ? '正在加载 MCP 设置…' : 'Loading MCP settings…'}</p>}>
        <McpEditor initialServerId={serverId} language={props.language} capabilities={capabilities} onNotify={setNotice} />
      </Suspense>} />
    {notice && <div className="settings-toast" role="status">{notice}</div>}
  </div>;
}
