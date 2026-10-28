import { uiText } from '../../i18n';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FilePenLine, GitBranch, MessageSquarePlus, MoreHorizontal, Play, Square, Trash2, Unlink, X } from 'lucide-react';
import { TEAM_WORKFLOW_COMMAND, teamWorkflowSchema, type DefinitionReceipt, type TeamWorkflow, type UserPromptInput } from '@cardbush/bush-protocol';
import type { CreationChatOptions, CreationInspectorContext } from '../mdPresentation/CreationConversation';
import type { MdPosition } from '../mdPresentation/markdownGraph';
import { ComposerPresentationContext } from '../composer/ComposerPresentationContext';
import { InspectorCoverControls } from '../inspector/InspectorCoverControls';
import { useQuickInputDismiss } from '../inspector/useQuickInputDismiss';
import { openBushItDocument } from '../mdPresentation/bushItDocuments';
import { useMarkdownFile } from '../mdPresentation/useMarkdownFile';
import { acceptTeamWorkflow, currentTeamWorkflow, refreshTeamWorkspace, teamCommand, useTeamWorkspace } from './teamWorkspaceStore';
import { teamFromMarkdown, teamToMarkdown } from './teamMarkdown';
import { consumeTeamDocumentRequest, setTeamOpenDocument, useTeamWorkspaceNavigation } from './teamWorkspaceNavigation';
import { TeamFlowDiagram } from './TeamFlowDiagram';
import { TeamViewPicker } from './TeamViewPicker';
import { TeamRunResults } from './TeamRunResults';
import { MarkdownContent, MessageFileReferenceScope } from '../chatMessages';
import { teamNodeTitle, teamStatusLabel } from './teamFlowGraph';
import { prepareTeamConversation, persistTeamConversation, resetTeamConversation } from './teamConversationStore';
import { teamConversationRequest } from './teamConversationContext';
const Conversation = lazy(() => import('../mdPresentation/CreationConversation').then(module => ({ default: module.CreationConversation })));

export function TeamGraphWorkspace({ language, chatOptions = {}, onOpenConversation, visible = true }: { language: string; chatOptions?: CreationChatOptions; onOpenConversation?: (id: string) => void; visible?: boolean }) {
  const state = useTeamWorkspace(), navigation = useTeamWorkspaceNavigation(), files = useMarkdownFile();

  const [teamId, setTeamId] = useState(() => navigation.document?.id || '');
  const [nodeId, setNodeId] = useState(''), [view, setView] = useState('definition');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [menu, setMenu] = useState(false), [deleting, setDeleting] = useState(false);
  const [imported, setImported] = useState<{ definition: TeamWorkflow; revision: number }>();
  const [pendingGraph, setPendingGraph] = useState<TeamWorkflow>();
  const [chat, setChat] = useState<CreationInspectorContext | null>(null);
  const [conversationVersion, setConversationVersion] = useState(0);
  const [inputTarget, setInputTarget] = useState<HTMLDivElement | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const localControls = visible && !chatOptions.externalComposerControls && !chatOptions.composerPortalTarget;
  const dismissInput = useCallback(() => setInputOpen(false), []);
  const openInput = useCallback(() => {
    if (chatOptions.externalComposerControls || chatOptions.composerPortalTarget) chatOptions.onOpenComposer?.();
    else setInputOpen(true);
  }, [chatOptions.externalComposerControls, chatOptions.composerPortalTarget, chatOptions.onOpenComposer]);
  useQuickInputDismiss(inputOpen && localControls, dismissInput, true);
  useEffect(dismissInput, [teamId, visible, dismissInput]);
  const operationPending = useRef(false);
  const graphSave = useRef<Promise<void> | undefined>(undefined);
  const activeTeam = useRef(teamId); activeTeam.current = teamId;
  const record = state.teams.find(item => item.definition.id === teamId);
  const runs = useMemo(() => state.runs.filter(run => run.teamId === teamId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.runs, teamId]);
  const run = !imported && view !== 'definition' ? (view === 'auto' ? runs.find(item => item.status === 'running') || (runs[0]?.teamRevision === record?.revision ? runs[0] : undefined) : runs.find(item => item.id === view)) : undefined;
  const graphSaving = pendingGraph?.id === teamId;
  const workflow = imported?.definition ?? run?.workflow ?? (graphSaving ? pendingGraph : undefined) ?? record?.definition;
  const node = workflow?.nodes.find(item => item.id === nodeId), nodeState = run?.nodes.find(item => item.id === nodeId);
  const agents = useMemo(() => (run?.agents ?? state.agents).map(item => item.definition), [run?.agents, state.agents]);
  const graphReadOnly = !!run || !!imported || busy || !record;
  const resumable = run && ['failed', 'stopped', 'interrupted'].includes(run.status);
  const foreignRun = run && run.parentSessionId !== chat?.sessionId;
  const open = (id: string, runId?: string) => { setTeamId(id); setView(runId || 'definition'); setNodeId(''); setImported(undefined); setError(''); setDeleting(false); setMenu(false); };
  const create = () => open(`team-${crypto.randomUUID().slice(0, 12)}`);
  useEffect(() => {
    if (!teamId && !state.loading && !navigation.request) open(state.teams.find(item => item.definition.id === state.selectedId)?.definition.id || state.teams[0]?.definition.id || `team-${crypto.randomUUID().slice(0, 12)}`);
  }, [teamId, state.loading, state.teams, navigation.request]);
  useEffect(() => {
    if (!teamId) return;
    setTeamOpenDocument({ id: teamId, name: record?.definition.name || run?.workflow.name || uiText(language)('teamGraphWorkspace.newWorkflow'), dirty: false }, busy || files.busy);
  }, [teamId, record?.definition.name, run?.workflow.name, busy, files.busy, language]);
  // Keep selected historical snapshots stable while new definition revisions update the default view.
  const revision = useRef({ teamId, value: record?.revision });
  useEffect(() => {
    if (revision.current.teamId === teamId && revision.current.value !== undefined && record?.revision !== revision.current.value && view === 'auto') setView('definition');
    revision.current = { teamId, value: record?.revision };
  }, [teamId, record?.revision, view]);
  const previousRun = useRef({ teamId, id: runs[0]?.id });
  useEffect(() => {
    if (previousRun.current.teamId === teamId && runs[0]?.id && previousRun.current.id !== runs[0].id) setView(current => current === 'definition' || current === 'auto' ? 'auto' : current);
    previousRun.current = { teamId, id: runs[0]?.id };
  }, [teamId, runs[0]?.id]);
  const importFile = async () => {
    setError(''); const result = await files.open(); if (!result) return;
    try {
      const definition = teamFromMarkdown(result.text), existing = state.teams.find(item => item.definition.id === definition.id);
      setImported({ definition, revision: existing?.revision ?? 0 }); setNodeId(''); setMenu(false);
    } catch (caught) { setError(String((caught as Error).message)); }
  };
  useEffect(() => {
    const request = navigation.request; if (!request || busy || files.busy || state.loading || !consumeTeamDocumentRequest(request)) return;
    if (request.kind === 'create') create();
    else if (request.kind === 'open') void importFile();
    else if (state.teams.some(item => item.definition.id === request.id) || state.runs.some(item => item.teamId === request.id && item.id === request.runId)) open(request.id, request.runId);
    else setError(uiText(language)('teamGraphWorkspace.thisWorkflowNoLongerExistsRefreshThe'));
  }, [navigation.request, busy, files.busy, state.loading]);
  const perform = async (operation: () => Promise<unknown>) => {
    if (operationPending.current) return; operationPending.current = true; setBusy(true); setError('');
    try { await graphSave.current; await operation(); }
    catch (caught) { setError(String((caught as Error).message)); }
    finally { await refreshTeamWorkspace(true); operationPending.current = false; setBusy(false); }
  };
  const saveGraph = async (nodes: TeamWorkflow['nodes']) => {
    if (graphReadOnly || !record || operationPending.current || graphSave.current) return;
    const result = teamWorkflowSchema.safeParse({ ...record.definition, nodes });
    if (!result.success) { setError(result.error.issues.some(issue => issue.message.includes('acyclic'))
      ? uiText(language)('teamGraphWorkspace.thisConnectionWouldCreateADependencyCycle') : result.error.issues[0].message); return; }
    setPendingGraph(result.data); setError('');
    // A graph edit updates this definition from its receipt. Do not put the app
    // shell into a loading state or re-fetch every agent and historical run.
    const saving = (async () => {
      try { acceptTeamWorkflow(await teamCommand<DefinitionReceipt<TeamWorkflow>>(TEAM_WORKFLOW_COMMAND,
        { action: 'save', definition: result.data, expected_revision: record.revision })); }
      catch (caught) {
        if (activeTeam.current === record.definition.id) setError(String((caught as Error).message).includes('Definition changed')
          ? uiText(language)('teamGraphWorkspace.theWorkflowChangedElsewhereReloadingTheLatest') : String((caught as Error).message));
        await refreshTeamWorkspace(true, true);
      }
    })();
    graphSave.current = saving;
    await saving;
    if (graphSave.current === saving) graphSave.current = undefined;
    setPendingGraph(value => value === result.data ? undefined : value);
  };
  const moveNodes = async (positions: Map<string, MdPosition>) => {
    if (!record || !record.definition.nodes.some(item => { const next = positions.get(item.id); return next && (next.x !== item.position?.x || next.y !== item.position?.y); })) return;
    await saveGraph(record.definition.nodes.map(item => positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item));
  };
  const connectNodes = (source: string, target: string) => {
    if (!record || source === target || !record.definition.nodes.some(item => item.id === source) || !record.definition.nodes.some(item => item.id === target && !item.depends_on.includes(source))) return;
    void saveGraph(record.definition.nodes.map(item => item.id === target ? { ...item, depends_on: [...item.depends_on, source] } : item));
  };
  const onContext = useCallback((value: CreationInspectorContext | null) => { setChat(value); chatOptions.onInspectorContext?.(value); }, [chatOptions.onInspectorContext]);
  const beforeSend = useCallback(async (input: UserPromptInput) => {
    if (imported) throw Error(uiText(language)('teamGraphWorkspace.importOrCancelThePreviewBeforeContinuing'));
    await graphSave.current;
    return teamConversationRequest(input, { teamId, revision: currentTeamWorkflow(teamId)?.revision ?? 0, ...(node ? { nodeId: node.id } : {}), ...(run ? { runId: run.id } : {}) });
  }, [imported, teamId, node?.id, run?.id, language]);
  useEffect(() => { if (chat) void refreshTeamWorkspace(false, true); }, [chat?.sessionId, chat?.busy]);
  const ask = (text: string) => { chat?.appendDraft(text); openInput(); inputTarget?.querySelector<HTMLElement>('[contenteditable=true],textarea')?.focus(); };
  return <div className="team-flow-workspace" data-team-id={teamId}>
    <header className="team-flow-header">
      <div><h1>{imported ? uiText(language)('teamGraphWorkspace.importPreview') : record?.definition.name || run?.workflow.name || uiText(language)('teamGraphWorkspace.newWorkflow_56384d2')}</h1>
        <p>{imported ? imported.definition.name : workflow?.description || uiText(language)('teamGraphWorkspace.describeYourGoalAiWillArrangeThe')}</p></div>
      <div className="team-flow-actions">
        {(record || runs.length > 0) && !imported && <TeamViewPicker record={record} runs={runs} run={run} language={language} disabled={busy}
          onChange={value => { setView(value); setNodeId(''); setError(''); }}/>}
        {run?.status === 'running' ? <button type="button" disabled={busy} onClick={() => void perform(() => teamCommand(TEAM_WORKFLOW_COMMAND, { action: 'stop', run_id: run.id }))}><Square size={14}/>{uiText(language)('automationPanel.stop')}</button>
          : resumable && foreignRun ? <button type="button" disabled={!onOpenConversation} onClick={() => onOpenConversation?.(run.parentSessionId)}>{uiText(language)('teamGraphWorkspace.continueInOriginalChat')}</button>
          : record && !imported && <button type="button" disabled={busy || !chat || chat.busy} onClick={() => { openInput(); void chat?.send(resumable ? uiText(language)('teamGraphWorkspace.resumeRunRetainingCompletedSteps', { value1: run.id }) : uiText(language)('teamGraphWorkspace.runThisWorkflow')); }}><Play size={14}/>{resumable ? uiText(language)('teamGraphWorkspace.resume') : uiText(language)('teamGraphWorkspace.run')}</button>}
        {record && !imported && <details className="team-flow-menu" open={menu} onToggle={event => setMenu(event.currentTarget.open)}>
          <summary aria-label={uiText(language)('teamGraphWorkspace.workflowActions')}><MoreHorizontal size={18}/></summary><div>
            <button type="button" disabled={!chat || chat.busy} onClick={() => { setMenu(false); resetTeamConversation(teamId); setConversationVersion(value => value + 1); openInput(); }}><MessageSquarePlus size={14}/>{uiText(language)('teamGraphWorkspace.newConversation')}</button>
            <button type="button" disabled={files.busy} onClick={() => { setMenu(false); void files.save(teamToMarkdown(record.definition), record.definition.name, true); }}><Download size={14}/>{uiText(language)('teamGraphWorkspace.exportMarkdown')}</button>
            <button type="button" onClick={() => { setMenu(false); openBushItDocument(teamToMarkdown(record.definition), { id: record.definition.id, revision: record.revision }); }}><FilePenLine size={14}/>{uiText(language)('teamGraphWorkspace.editMarkdownInCreate')}</button>
            <button type="button" onClick={() => { setMenu(false); setDeleting(true); }}><Trash2 size={14}/>{uiText(language)('teamGraphWorkspace.deleteWorkflow')}</button>
          </div></details>}
      </div>
    </header>
    {(error || files.error) && <div className="team-flow-notice" role="alert">{error || files.error}<button type="button" aria-label={uiText(language)('creationCanvasApp.dismiss')} onClick={() => { setError(''); files.clear(); }}><X size={14}/></button></div>}
    {imported && <div className="team-flow-notice"><span>{imported.revision ? uiText(language)('teamGraphWorkspace.importUpdatesTheExistingWorkflowWithThis') : uiText(language)('teamGraphWorkspace.importIntoYourLibraryWithoutRunningIt')}</span>
      <button type="button" disabled={busy} onClick={() => void perform(async () => { const receipt = await teamCommand<DefinitionReceipt<TeamWorkflow>>(TEAM_WORKFLOW_COMMAND, { action: 'save', definition: imported.definition, expected_revision: imported.revision }); open(receipt.definition.id); })}>{uiText(language)('teamGraphWorkspace.importWorkflow')}</button>
      <button type="button" disabled={busy} onClick={() => { setImported(undefined); setNodeId(''); }}>{uiText(language)('agentConnectionForm.cancel')}</button></div>}
    {deleting && <div className="team-flow-notice" role="alert"><span>{uiText(language)('teamGraphWorkspace.deleteThisWorkflowRunsAndConversationsAre')}</span>
      <button type="button" disabled={busy || chat?.busy} onClick={() => void perform(async () => { await teamCommand(TEAM_WORKFLOW_COMMAND, { action: 'delete', team_id: teamId, expected_revision: currentTeamWorkflow(teamId)?.revision }); create(); })}>{uiText(language)('teamGraphWorkspace.delete')}</button>
      <button type="button" onClick={() => setDeleting(false)}>{uiText(language)('agentConnectionForm.cancel')}</button></div>}
    <div className="team-flow-body">
      {workflow ? <>
        {run && <div className="team-flow-run-caption"><span data-status={run.status}>{teamStatusLabel(run.status, language)}</span><span>{run.nodes.filter(item => item.status === 'completed').length} / {run.nodes.length} {uiText(language)('teamViewPicker.steps')} {uiText(language)('teamGraphWorkspace.v')}{run.teamRevision}</span><span title={run.input}>{run.input}</span>{record && <button type="button" disabled={busy} onClick={() => { setView('definition'); setNodeId(''); }}>{uiText(language)('teamGraphWorkspace.editCurrentWorkflow')}</button>}</div>}
        {run?.error && <div className="team-flow-notice" role="alert">{run.error}</div>}
        {run && <TeamRunResults run={run} language={language} workspaceRoot={run.parentSessionId === chat?.sessionId ? chat.root : undefined} onOpenConversation={onOpenConversation}/>}
        <TeamFlowDiagram workflow={workflow} run={run || undefined} agents={agents} selectedId={nodeId} onSelect={id => setNodeId(current => current === id ? '' : id)} language={language}
          readOnly={graphReadOnly} saving={graphSaving} onPositions={moveNodes} onConnect={connectNodes}/>
        {node && <section className="team-flow-detail" aria-label={uiText(language)('teamGraphWorkspace.stepDetails')}>
          <header><strong>{teamNodeTitle(node, agents)}</strong><span>{teamStatusLabel(nodeState?.status || 'idle', language)}</span><button type="button" aria-label={uiText(language)('teamGraphWorkspace.closeStepDetails')} onClick={() => setNodeId('')}><X size={15}/></button></header>
          <div className="team-flow-detail-content"><p className="team-flow-agent">{agents.find(item => item.id === node.agent_id)?.name || node.agent_id}</p><p>{node.prompt}</p>
            {!!node.depends_on.length && <details open={!run}><summary>{uiText(language)('teamGraphWorkspace.inputsAndUpstreamResults')}</summary>{node.depends_on.map(id => { const upstream = workflow.nodes.find(item => item.id === id)!; return <div key={id}>
              <div className="team-flow-dependency"><strong>{teamNodeTitle(upstream, agents)}</strong>{!run && !imported && <button type="button" disabled={graphReadOnly} aria-label={uiText(language)('teamGraphWorkspace.removeDependency', { value1: teamNodeTitle(upstream, agents) })} onClick={() => void saveGraph(record!.definition.nodes.map(item => item.id === node.id ? { ...item, depends_on: item.depends_on.filter(dependency => dependency !== id) } : item))}><Unlink size={13}/>{uiText(language)('teamGraphWorkspace.unlink')}</button>}</div>
              {run && <MessageFileReferenceScope workspaceRoot={run.parentSessionId === chat?.sessionId ? chat.root : undefined}><MarkdownContent content={run.nodes.find(item => item.id === id)?.output || uiText(language)('teamGraphWorkspace.availableWhenTheUpstreamStepCompletes')} language={language}/></MessageFileReferenceScope>}</div>; })}</details>}
            {nodeState?.error && <p role="alert">{nodeState.error}</p>}{nodeState?.output && <div className="team-flow-result"><strong>{uiText(language)('teamGraphWorkspace.result')}</strong><MessageFileReferenceScope workspaceRoot={run?.parentSessionId === chat?.sessionId ? chat?.root : undefined}><MarkdownContent content={nodeState.output} language={language}/></MessageFileReferenceScope></div>}
          </div>{!imported && <button type="button" className="team-flow-edit-step" disabled={!chat} onClick={() => ask(uiText(language)('teamGraphWorkspace.changeTheStep', { value1: node.name || node.id }))}>{uiText(language)('teamGraphWorkspace.askAiToChangeThisStep')}</button>}
        </section>}
      </> : <div className="team-flow-empty"><GitBranch size={28}/><h2>{uiText(language)('teamGraphWorkspace.startWithAGoal')}</h2><p>{uiText(language)('teamGraphWorkspace.tellAiWhatToAccomplishTheWorkflow')}</p>
        <div className="team-flow-example" aria-label={uiText(language)('teamGraphWorkspace.exampleOnlyNotASavedWorkflow')}><span>{uiText(language)('teamGraphWorkspace.research')}</span><i>→</i><span>{uiText(language)('teamGraphWorkspace.analyze')}</span><i>→</i><span>{uiText(language)('teamGraphWorkspace.review')}</span></div>
        <small>{uiText(language)('teamGraphWorkspace.exampleAiSetsUpRolesConnectionsAnd')}</small>
      </div>}
    </div>
    {localControls && <InspectorCoverControls language={language} inputOpen={inputOpen} status={chat?.inputStatus} onTargetChange={setInputTarget}
      onToggleInput={() => setInputOpen(value => !value)}/>}
    {teamId && <TeamConversation key={`${teamId}:${conversationVersion}`} teamId={teamId} title={record?.definition.name || uiText(language)('teamGraphWorkspace.newWorkflow')} language={language} visible={visible && (inputOpen || !!chatOptions.composerPortalTarget)}
      chatOptions={chatOptions} target={localControls && inputOpen ? inputTarget : null} beforeSend={beforeSend} onContext={onContext} onOpen={openInput}/>}
  </div>;
}

const TeamConversation = memo(function TeamConversation({ teamId, title, language, visible, chatOptions, target, beforeSend, onContext, onOpen }: {
  teamId: string; title: string; language: string; visible: boolean; chatOptions: CreationChatOptions; target: HTMLElement | null;
  beforeSend: (input: UserPromptInput) => Promise<UserPromptInput>; onContext: (context: CreationInspectorContext | null) => void; onOpen: () => void;
}) {
  const [session] = useState(() => prepareTeamConversation(teamId));
  return <ComposerPresentationContext.Provider value={{ portalInputOnly: !!chatOptions.composerPortalTarget, preservePermissions: true }}>
    <Suspense fallback={null}><Conversation {...chatOptions} {...session} scope="team" language={language} visible={visible} beforeSend={beforeSend}
      preparation={session.draft ? { title: `${uiText(language)('teamGraphWorkspace.workflow')} · ${title}`, metadata: { team_workspace: true, team_workspace_id: teamId },
        onCreated: conversation => persistTeamConversation(teamId, conversation) } : undefined}
      contextLabel={title} composerPortalTarget={visible ? chatOptions.composerPortalTarget ?? target : null} onInspectorContext={onContext} onOpen={onOpen}/></Suspense>
  </ComposerPresentationContext.Provider>;
});
