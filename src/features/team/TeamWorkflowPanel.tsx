import {
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  Plus,
  Save,
  Settings2,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { AppLanguage } from '../../types';
import { validateTeamWorkflow } from '../../backend/api';
import {
  createTeamWorkflow,
  createTeamWorkflowNode,
  persistTeamWorkflows,
  readTeamWorkflows,
  workflowToYaml,
  type TeamWorkflow,
  type TeamWorkflowNode,
} from './workflowModel';
import './team-workflow.css';


export function TeamWorkflowPanel({
  language,
  activeProjectDir,
  workflowValidationAvailable,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
}) {
  const zh = language === 'zh';
  const [workflows, setWorkflows] = useState(readTeamWorkflows);
  const [activeWorkflowId, setActiveWorkflowId] = useState(() => readTeamWorkflows()[0]?.id ?? '');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [savedPath, setSavedPath] = useState('');
  const [saveError, setSaveError] = useState('');
  const [copyDone, setCopyDone] = useState(false);
  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0];
  const selectedNode = activeWorkflow?.nodes.find((node) => node.id === selectedNodeId)
    ?? activeWorkflow?.nodes[0]
    ?? null;
  const yaml = activeWorkflow ? workflowToYaml(activeWorkflow) : '';

  useEffect(() => {
    persistTeamWorkflows(workflows);
  }, [workflows]);

  useEffect(() => {
    if (!activeWorkflow) return;
    setSelectedNodeId((current) => (
      activeWorkflow.nodes.some((node) => node.id === current)
        ? current
        : activeWorkflow.nodes[0]?.id ?? ''
    ));
    setSettingsOpen(false);
    setYamlOpen(false);
    setLibraryOpen(false);
    setDetailsOpen(false);
    setSavedPath('');
    setSaveError('');
  }, [activeWorkflow?.id]);

  useEffect(() => {
    if (!libraryOpen && !detailsOpen) return undefined;
    const closePopover = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('.team-workflow-topbar')) return;
      setLibraryOpen(false);
      setDetailsOpen(false);
    };
    window.addEventListener('pointerdown', closePopover);
    return () => window.removeEventListener('pointerdown', closePopover);
  }, [detailsOpen, libraryOpen]);

  const updateWorkflow = useCallback((update: (workflow: TeamWorkflow) => TeamWorkflow) => {
    setWorkflows((current) => current.map((workflow) => (
      workflow.id === activeWorkflowId
        ? { ...update(workflow), updatedAt: new Date().toISOString() }
        : workflow
    )));
    setSavedPath('');
    setSaveError('');
  }, [activeWorkflowId]);

  const updateNode = useCallback((nodeId: string, patch: Partial<TeamWorkflowNode>) => {
    updateWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
    }));
  }, [updateWorkflow]);

  const addWorkflow = () => {
    const workflow = createTeamWorkflow(zh ? '未命名工作流' : 'Untitled Workflow');
    setWorkflows((current) => [workflow, ...current]);
    setActiveWorkflowId(workflow.id);
    setSelectedNodeId(workflow.nodes[0]?.id ?? '');
    setLibraryOpen(false);
    setDetailsOpen(true);
  };

  const deleteWorkflow = () => {
    if (!activeWorkflow || workflows.length <= 1) return;
    const next = workflows.filter((workflow) => workflow.id !== activeWorkflow.id);
    setWorkflows(next);
    setActiveWorkflowId(next[0]?.id ?? '');
  };

  const addNode = () => {
    if (!activeWorkflow) return;
    const node = createTeamWorkflowNode(undefined, zh ? '新场景 Agent' : 'New scene agent');
    node.dependsOn = selectedNode ? [selectedNode.id] : [];
    updateWorkflow((workflow) => ({ ...workflow, nodes: [...workflow.nodes, node] }));
    setSelectedNodeId(node.id);
    setSettingsOpen(false);
    setYamlOpen(false);
  };

  const deleteNode = () => {
    if (!activeWorkflow || !selectedNode || activeWorkflow.nodes.length <= 1) return;
    const currentIndex = activeWorkflow.nodes.findIndex((node) => node.id === selectedNode.id);
    const nextNodes = activeWorkflow.nodes
      .filter((node) => node.id !== selectedNode.id)
      .map((node) => ({
        ...node,
        dependsOn: node.dependsOn.filter((dependency) => dependency !== selectedNode.id),
      }));
    updateWorkflow((workflow) => ({ ...workflow, nodes: nextNodes }));
    setSelectedNodeId(nextNodes[Math.max(0, currentIndex - 1)]?.id ?? nextNodes[0]?.id ?? '');
  };

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSettingsOpen(false);
    setYamlOpen(false);
  };

  const saveYaml = async () => {
    if (!activeWorkflow) return;
    setSaveError('');
    try {
      if (workflowValidationAvailable) {
        const validation = await validateTeamWorkflow({ yaml });
        if (!validation.valid) {
          const firstError = validation.errors[0];
          const message = String(firstError?.message ?? firstError?.detail ?? '').trim();
          throw new Error(message || (zh ? '工作流未通过后端校验' : 'Workflow validation failed'));
        }
      }
      if (window.cardbushDesktop?.saveTeamWorkflow) {
        const result = await window.cardbushDesktop.saveTeamWorkflow({
          projectDir: activeProjectDir,
          workflowId: activeWorkflow.id,
          yaml,
        });
        setSavedPath(result.path);
      } else {
        const blobUrl = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }));
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = `${activeWorkflow.id}.yaml`;
        anchor.click();
        URL.revokeObjectURL(blobUrl);
        setSavedPath(`${activeWorkflow.id}.yaml`);
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const copyYaml = async () => {
    await navigator.clipboard.writeText(yaml);
    setCopyDone(true);
    window.setTimeout(() => setCopyDone(false), 1200);
  };

  if (!activeWorkflow || !selectedNode) return null;

  return (
    <div className="team-workflow-content">
      <div className="team-workflow-topbar">
        <header className="team-workflow-toolbar">
          <button
            className={`team-workflow-switcher${libraryOpen ? ' active' : ''}`}
            type="button"
            aria-expanded={libraryOpen}
            onClick={() => {
              setLibraryOpen((current) => !current);
              setDetailsOpen(false);
            }}
          >
            <Workflow size={15} />
            <span>
              <strong>{activeWorkflow.name}</strong>
              <small>{activeWorkflow.nodes.length} {zh ? '个场景 Agent' : 'scene agents'}</small>
            </span>
            <ChevronDown size={14} />
          </button>
          <div className="team-workflow-toolbar-actions">
            <button
              className={detailsOpen ? 'active' : ''}
              type="button"
              title={zh ? '工作流信息' : 'Workflow details'}
              aria-label={zh ? '工作流信息' : 'Workflow details'}
              onClick={() => {
                setDetailsOpen((current) => !current);
                setLibraryOpen(false);
              }}
            >
              <Settings2 size={15} />
            </button>
            <button
              className={yamlOpen ? 'active' : ''}
              type="button"
              title={zh ? '查看 YAML' : 'View YAML'}
              aria-label={zh ? '查看 YAML' : 'View YAML'}
              onClick={() => {
                setYamlOpen((current) => !current);
                setLibraryOpen(false);
                setDetailsOpen(false);
              }}
            >
              <FileCode2 size={15} />
            </button>
            <button
              className="primary"
              type="button"
              title={zh ? '保存 YAML' : 'Save YAML'}
              aria-label={zh ? '保存 YAML' : 'Save YAML'}
              onClick={() => void saveYaml()}
            >
              <Save size={15} />
            </button>
          </div>
        </header>

        {libraryOpen && (
          <nav className="team-workflow-popover team-workflow-library" aria-label={zh ? '工作流库' : 'Workflow library'}>
            <div className="team-workflow-popover-heading">
              <span>{zh ? '工作流' : 'Workflows'}</span>
              <button type="button" onClick={addWorkflow}><Plus size={14} />{zh ? '新建' : 'New'}</button>
            </div>
            <div className="team-workflow-library-list">
              {workflows.map((workflow) => (
                <button
                  className={`team-workflow-tile${workflow.id === activeWorkflow.id ? ' active' : ''}`}
                  key={workflow.id}
                  type="button"
                  onClick={() => {
                    setActiveWorkflowId(workflow.id);
                    setLibraryOpen(false);
                  }}
                >
                  <Workflow size={14} />
                  <span>
                    <strong>{workflow.name}</strong>
                    <small>{workflow.nodes.length} {zh ? '个节点' : 'nodes'}</small>
                  </span>
                  {workflow.id === activeWorkflow.id && <Check size={14} />}
                </button>
              ))}
            </div>
          </nav>
        )}

        {detailsOpen && (
          <section className="team-workflow-popover team-workflow-details">
            <div className="team-workflow-popover-heading">
              <span>{zh ? '工作流信息' : 'Workflow details'}</span>
              <small>{activeProjectDir ? (zh ? '项目工作流' : 'Project') : (zh ? '全局工作流' : 'Global')}</small>
            </div>
            <label>
              <span>{zh ? '名称' : 'Name'}</span>
              <input
                className="team-workflow-name"
                value={activeWorkflow.name}
                onChange={(event) => updateWorkflow((workflow) => ({ ...workflow, name: event.currentTarget.value }))}
              />
            </label>
            <label>
              <span>{zh ? '用途' : 'Purpose'}</span>
              <textarea
                className="team-workflow-description"
                value={activeWorkflow.description}
                placeholder={zh ? '这条工作流解决什么问题？' : 'What does this workflow solve?'}
                onChange={(event) => updateWorkflow((workflow) => ({ ...workflow, description: event.currentTarget.value }))}
              />
            </label>
            <button
              className="team-workflow-delete"
              type="button"
              disabled={workflows.length <= 1}
              onClick={deleteWorkflow}
            >
              <Trash2 size={14} />{zh ? '删除工作流' : 'Delete workflow'}
            </button>
          </section>
        )}
      </div>

      <section className="team-workflow-stage">
        {yamlOpen ? (
          <YamlPanel
            copyDone={copyDone}
            fileName={`${activeWorkflow.id}.yaml`}
            language={language}
            yaml={yaml}
            onCopy={() => void copyYaml()}
          />
        ) : (
          <NodeDeck
            language={language}
            workflow={activeWorkflow}
            node={selectedNode}
            settingsOpen={settingsOpen}
            onAdd={addNode}
            onDelete={deleteNode}
            onSelect={selectNode}
            onSettingsToggle={() => setSettingsOpen((current) => !current)}
            onUpdate={(patch) => updateNode(selectedNode.id, patch)}
          />
        )}

        {(savedPath || saveError) && (
          <footer className={`team-workflow-save-status${saveError ? ' error' : ''}`}>
            {saveError || `${zh ? '已保存到' : 'Saved to'} ${savedPath}`}
          </footer>
        )}
      </section>
    </div>
  );
}

function NodeDeck({
  language,
  workflow,
  node,
  settingsOpen,
  onAdd,
  onDelete,
  onSelect,
  onSettingsToggle,
  onUpdate,
}: {
  language: AppLanguage;
  workflow: TeamWorkflow;
  node: TeamWorkflowNode;
  settingsOpen: boolean;
  onAdd: () => void;
  onDelete: () => void;
  onSelect: (nodeId: string) => void;
  onSettingsToggle: () => void;
  onUpdate: (patch: Partial<TeamWorkflowNode>) => void;
}) {
  const zh = language === 'zh';
  const nodeIndex = workflow.nodes.findIndex((candidate) => candidate.id === node.id);
  return (
    <div className="team-node-workspace">
      <aside className="team-agent-rail" aria-label={zh ? '场景 Agent' : 'Scene agents'}>
        <div className="team-agent-track">
          {workflow.nodes.map((candidate, index) => (
            <button
              aria-label={`${zh ? '切换到' : 'Switch to'} ${candidate.title}`}
              className={`team-agent-marker${candidate.id === node.id ? ' active' : ''}`}
              key={candidate.id}
              type="button"
              onClick={() => onSelect(candidate.id)}
            >
              <span className="team-agent-marker-line" />
              <span className="team-agent-preview">
                <small>{String(index + 1).padStart(2, '0')} · Skills / Tools</small>
                <strong>{candidate.title}</strong>
                <em>
                  {candidate.dependsOn.length
                    ? `${candidate.dependsOn.length} ${zh ? '个上游' : 'upstream'}`
                    : zh ? '起始节点' : 'Starting node'}
                </em>
              </span>
            </button>
          ))}
        </div>
        <button className="team-agent-add" type="button" title={zh ? '增加 Agent' : 'Add agent'} onClick={onAdd}>
          <Plus size={14} />
        </button>
      </aside>

      <article className={`team-workflow-node-card active${settingsOpen ? ' settings-open' : ''}`} key={node.id}>
        <header className="team-node-card-header">
          <div>
            <span>{zh ? `场景 Agent ${nodeIndex + 1}` : `Scene agent ${nodeIndex + 1}`}</span>
            <input
              aria-label={zh ? 'Agent 名称' : 'Agent name'}
              value={node.title}
              onChange={(event) => onUpdate({ title: event.currentTarget.value })}
            />
          </div>
          <button
            className="danger"
            type="button"
            disabled={workflow.nodes.length <= 1}
            title={zh ? '删除节点' : 'Delete node'}
            onClick={onDelete}
          >
            <Trash2 size={15} />
          </button>
        </header>

        <label className="team-node-prompt">
          <span>{zh ? '提示词' : 'Prompt'}</span>
          <textarea
            value={node.prompt}
            placeholder={zh ? '告诉这个 Agent 要完成什么、不要做什么，以及期望得到什么结果。' : 'Tell this agent what to do, what to avoid, and what result to produce.'}
            onChange={(event) => onUpdate({ prompt: event.currentTarget.value })}
          />
        </label>

        <div className="team-node-card-footer">
          <div className="team-node-summary">
            <span>{zh ? '运行时' : 'Runtime'} <strong>Skills / Tools</strong></span>
            <span>{zh ? '上游' : 'Upstream'} <strong>{node.dependsOn.length}</strong></span>
            <span>{zh ? '验收' : 'Validation'} <strong>{node.validation.trim() ? (zh ? '已定义' : 'Ready') : (zh ? '未定义' : 'None')}</strong></span>
          </div>
          <button className={settingsOpen ? 'active' : ''} type="button" onClick={onSettingsToggle}>
            <Settings2 size={14} />{zh ? '节点设置' : 'Node settings'}<ChevronDown size={13} />
          </button>
        </div>

        {settingsOpen && (
          <div className="team-node-settings">
            <fieldset>
              <legend>{zh ? '完成这些节点后开始' : 'Start after these nodes'}</legend>
              <div>
                {workflow.nodes.filter((dependency) => dependency.id !== node.id).map((dependency) => {
                  const checked = node.dependsOn.includes(dependency.id);
                  return (
                    <label key={dependency.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onUpdate({
                          dependsOn: checked
                            ? node.dependsOn.filter((id) => id !== dependency.id)
                            : [...node.dependsOn, dependency.id],
                        })}
                      />
                      <span>{dependency.title}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="validation">
              <span>{zh ? '验收标准' : 'Validation'}</span>
              <textarea
                value={node.validation}
                placeholder={zh ? '可选：怎样判断这个 Agent 已经完成？' : 'Optional: how is completion verified?'}
                onChange={(event) => onUpdate({ validation: event.currentTarget.value })}
              />
            </label>
          </div>
        )}
      </article>
    </div>
  );
}

function YamlPanel({
  language,
  fileName,
  yaml,
  copyDone,
  onCopy,
}: {
  language: AppLanguage;
  fileName: string;
  yaml: string;
  copyDone: boolean;
  onCopy: () => void;
}) {
  const zh = language === 'zh';
  return (
    <div className="team-workflow-yaml">
      <div className="team-workflow-yaml-toolbar">
        <span>{fileName}</span>
        <button type="button" onClick={onCopy}>
          {copyDone ? <Check size={14} /> : <Copy size={14} />}
          {copyDone ? (zh ? '已复制' : 'Copied') : (zh ? '复制' : 'Copy')}
        </button>
      </div>
      <pre>{yaml}</pre>
    </div>
  );
}
