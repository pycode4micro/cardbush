import React, { useContext, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationExtractionProvider, ConversationExtractionContext, ExtractionSelector } from '../../src/features/chat/ConversationExtraction';
import { ChatSidebar } from '../../src/features/sidebar/ChatSidebar';
import { Composer } from '../../src/features/composer/Composer';
import { ComposerReferenceContext } from '../../src/features/composer/ComposerReferenceContext';
import { OPEN_INSPECTOR_EVENT } from '../../src/features/inspector/inspectorEvents';
import '../../src/styles/theme.css';
import '../../src/styles/app.css';

const noop = () => {};
window.openRequests = [];
window.addEventListener(OPEN_INSPECTOR_EVENT, event => window.openRequests.push(event.detail));
const messages = Array.from({ length: 7 }, (_, i) => [
  { id: `t${i + 1}-0`, messageId: `t${i + 1}-0`, turnId: `t${i + 1}`, role: 'user', content: `请求 ${i + 1}：检查构建并保留操作结论。` },
  { id: `t${i + 1}-1`, messageId: `t${i + 1}-1`, turnId: `t${i + 1}`, role: 'assistant', content: `回复 ${i + 1}：构建已完成，可以在其他会话继续。` },
]).flat();
function Controls() {
  const ctx = useContext(ConversationExtractionContext);
  window.extractContext = ctx;
  return null;
}
function Harness() {
  const [active, setActive] = useState('source'), [draft, setDraft] = useState(''), [tokens, setTokens] = useState(16000);
  const [conversations, setConversations] = useState([{ id: 'source', title: '构建和验证记录', updatedAt: new Date().toISOString(), preview: '构建结论' },
    { id: 'other', title: '另一个会话', updatedAt: new Date().toISOString(), preview: '继续工作' }]);
  const target = useRef(null);
  window.setModelTokens = setTokens; window.setDraft = setDraft; window.draftValue = draft; window.activeSession = active;
  return <ConversationExtractionProvider activeSessionId={active} contextWindowTokens={tokens} language="zh" onOpen={setActive}
    onFork={async sourceSessionId => { const result = await window.testExtract.fork(sourceSessionId); setConversations(old => [...old, result]); setActive(result.id); }}>
    <div className="app theme-dark" style={{ height: '100vh', display: 'flex', padding: 20, gap: 24 }}>
      <Controls />
      <div style={{ width: 230, flexShrink: 0 }}><ChatSidebar language="zh" section="chat" activeConversationId={active}
        projects={[]} conversations={conversations} changeReportsByConversation={{}} onSectionChange={noop} onConversationChange={setActive}
        onCreateConversation={noop} onAddProject={noop} onProjectAction={noop} onDeleteConversation={noop}
        onRenameConversation={async () => true} onOpenConversationChanges={noop} onOpenSettings={noop} onOpenPlugins={noop} onOpenSearch={noop} /></div>
      <main ref={target} style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div className="message-list" style={{ flex: 1, overflow: 'auto' }}>
          {messages.map(message => <div key={message.id} className="message-list-item" data-message-id={message.id} style={{ margin: '16px 30px', padding: 20 }}>
            <ExtractionSelector message={message} sessionId={active} /><p style={{ textAlign: message.role === 'user' ? 'right' : 'left' }}>{message.content}</p>
          </div>)}
        </div>
        <ComposerReferenceContext.Provider value={{ sessionId: active, messages, browserTabs: [] }}>
          <Composer language="zh" draft={draft} onDraftChange={setDraft} fileDropTarget={target} sending={false}
            selectedModel="model" availableModels={[{ id: 'model', displayName: '测试模型', modelName: 'test-model', maxContextTokens: tokens }]}
            referencePlanAvailable={false} referencePlanMode="off" permissionMode="all_free" subagentPermissionRouting="inherit"
            reasoningLevelAvailable={false} reasoningLevel="medium" reasoningLevels={['medium']}
            onModelChange={noop} onReferencePlanModeChange={noop} onPermissionModeChange={noop} onSubagentPermissionRoutingChange={noop}
            onReasoningLevelChange={noop} onSend={async () => {}} onCancel={async () => {}} disabledSkillNames={new Set()}
            onConfigureModels={noop} onToggleSkill={noop} />
        </ComposerReferenceContext.Provider>
      </main>
    </div>
  </ConversationExtractionProvider>;
}
createRoot(document.getElementById('root')).render(<Harness />);
