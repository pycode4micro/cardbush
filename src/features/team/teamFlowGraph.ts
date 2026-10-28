import { uiText } from '../../i18n';
import type { MessageKey } from '../../i18n';
import type { RegisteredAgent, TeamWorkflow } from '@cardbush/bush-protocol';
import type { MdDocument } from '../mdPresentation/markdownGraph';

export function teamNodeTitle(node: TeamWorkflow['nodes'][number], agents: RegisteredAgent[]) {
  return node.name || agents.find(agent => agent.id === node.agent_id)?.name || node.id;
}

/** Adapt canonical tasks directly; prompt links and Markdown notes never create execution edges. */
export function teamGraphDocument(workflow: TeamWorkflow, agents: RegisteredAgent[] = []): MdDocument {
  return { attributes: {}, introduction: '', nodes: workflow.nodes.map(node => ({
    id: node.id, body: '', attributes: { name: teamNodeTitle(node, agents), agent_id: node.agent_id,
      depends_on: [...node.depends_on], ...(node.position ? { position: { ...node.position } } : {}) },
  })) };
}

export function teamStatusLabel(status: string, language: string) {
  const labels: Record<string, MessageKey> = { idle: 'teamWorkflowLibrary.notRun' as const, pending: 'cardlingWindow.waiting' as const, running: 'cardlingWindow.running' as const,
    completed: 'automationPanel.completed' as const, failed: 'automationPanel.failed' as const, stopped: 'automationPanel.stopped' as const, interrupted: 'browserLibraryDialog.interrupted' as const };
  return (labels[status] && uiText(language)(labels[status])) ?? status;
}
