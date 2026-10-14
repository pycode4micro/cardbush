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

export function teamStatusLabel(status: string, language: 'zh' | 'en') {
  const labels: Record<string, [string, string]> = { idle: ['未运行', 'Not run'], pending: ['等待', 'Waiting'], running: ['运行中', 'Running'],
    completed: ['已完成', 'Completed'], failed: ['失败', 'Failed'], stopped: ['已停止', 'Stopped'], interrupted: ['已中断', 'Interrupted'] };
  return labels[status]?.[language === 'zh' ? 0 : 1] ?? status;
}
