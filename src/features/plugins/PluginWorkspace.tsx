import { uiText } from '../../i18n';
import { Suspense, useEffect, useLayoutEffect, useState, type ComponentProps, type ReactNode } from 'react';
import type { AppLanguage, BackendCapabilities } from '../../types';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import { PluginManagementPanel } from './PluginManagementPanel';
import { subscribePluginDetailsRequest, takePluginDetailsRequest } from './pluginNavigationRequests';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';

function McpEditorNotice({ language, onClose, children }: { language: AppLanguage; onClose?: () => void; children: ReactNode }) {
  if (!onClose) return children;
  return <SettingsFormDialog className="mcp-server-dialog" language={language} title={uiText(language)('pluginWorkspace.mcpServers')}
    onCancel={onClose} onSubmit={() => {}} footer={<button className="secondary-button" type="button" onClick={onClose}>{uiText(language)('common.close')}</button>}>
    {children}
  </SettingsFormDialog>;
}

// Reuse the existing MCP editor without opening the settings shell. Load it
// only when a server is selected, keeping the catalog entry lightweight.
const McpEditor = recoverableLazy('plugin-mcp-editor', async () => {
  const module = await import('../SettingsView');
  return { default: module.McpServersPanel };
}, (props, retry) => <McpEditorNotice language={props.language} onClose={props.dialogOnly ? props.onClose : undefined}>
  <DeferredModuleNotice language={props.language} retry={retry} />
</McpEditorNotice>);

type Props = Pick<ComponentProps<typeof PluginManagementPanel>,
  'language' | 'skills' | 'disabledSkillNames' | 'onToggleSkill' | 'onReloadSkills' | 'onLoadSkillDetail' | 'onOpenPrompt'> & {
  capabilities: BackendCapabilities;
};

export function PluginWorkspace({ capabilities, ...props }: Props) {
  const [notice, setNotice] = useState('');
  const [requestedPlugin, setRequestedPlugin] = useState<ReturnType<typeof takePluginDetailsRequest>>();
  useLayoutEffect(() => {
    const receive = () => { const request = takePluginDetailsRequest(); if (request) setRequestedPlugin(request); };
    const unsubscribe = subscribePluginDetailsRequest(receive); receive(); return unsubscribe;
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return <div className="feature-content plugin-workspace-scroll" data-plugin-scroll-container>
    <PluginManagementPanel {...props} initialTab="plugins" onNotify={setNotice} requestedPlugin={requestedPlugin}
      renderMcp={(serverId, dialog) => <Suspense fallback={<McpEditorNotice language={props.language} onClose={dialog?.onClose}>
        <p role="status">{uiText(props.language)('pluginWorkspace.loadingMcpSettings')}</p>
      </McpEditorNotice>}>
        <McpEditor initialServerId={serverId} initialCreate={!serverId} {...dialog} language={props.language} capabilities={capabilities} onNotify={setNotice} />
      </Suspense>} />
    {notice && <div className="settings-toast" role="status">{notice}</div>}
  </div>;
}
