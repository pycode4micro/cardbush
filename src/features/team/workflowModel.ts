export const teamWorkflowProtocol = 'cardbush.team_workflow.v1';

export type TeamWorkflowNode = {
  id: string;
  title: string;
  prompt: string;
  dependsOn: string[];
  validation: string;
};

export type TeamWorkflow = {
  protocol: typeof teamWorkflowProtocol;
  id: string;
  name: string;
  description: string;
  version: number;
  updatedAt: string;
  nodes: TeamWorkflowNode[];
};

const storageKey = 'cardbush_team_workflows_v1';

export function readTeamWorkflows(): TeamWorkflow[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(parsed)) return seededWorkflows();
    const workflows = parsed.map(normalizeWorkflow).filter(Boolean) as TeamWorkflow[];
    return workflows.length > 0 ? workflows : seededWorkflows();
  } catch {
    return seededWorkflows();
  }
}

export function persistTeamWorkflows(workflows: TeamWorkflow[]) {
  window.localStorage.setItem(storageKey, JSON.stringify(workflows));
}

export function createTeamWorkflow(name = 'Untitled Workflow'): TeamWorkflow {
  const id = uniqueWorkflowId(name);
  return {
    protocol: teamWorkflowProtocol,
    id,
    name,
    description: '',
    version: 1,
    updatedAt: new Date().toISOString(),
    nodes: [createTeamWorkflowNode('entry', 'Start')],
  };
}

export function createTeamWorkflowNode(id?: string, title = 'New Agent'): TeamWorkflowNode {
  return {
    id: id ?? `agent-${Math.random().toString(36).slice(2, 7)}`,
    title,
    prompt: '',
    dependsOn: [],
    validation: '',
  };
}

export function workflowToYaml(workflow: TeamWorkflow) {
  const lines = [
    `protocol: ${teamWorkflowProtocol}`,
    `id: ${yamlScalar(workflow.id)}`,
    `name: ${yamlScalar(workflow.name)}`,
    `version: ${Math.max(1, Math.round(workflow.version))}`,
  ];
  if (workflow.description.trim()) {
    lines.push('description: |-');
    lines.push(...yamlBlock(workflow.description));
  }
  lines.push('', 'nodes:');
  for (const node of workflow.nodes) {
    lines.push(`  - id: ${yamlScalar(node.id)}`);
    lines.push(`    title: ${yamlScalar(node.title)}`);
    lines.push('    prompt: |-');
    lines.push(...yamlBlock(node.prompt, 6));
    lines.push(
      node.dependsOn.length > 0
        ? `    depends_on: [${node.dependsOn.map(yamlScalar).join(', ')}]`
        : '    depends_on: []',
    );
    if (node.validation.trim()) {
      lines.push('    validation: |-');
      lines.push(...yamlBlock(node.validation, 6));
    }
  }
  return `${lines.join('\n')}\n`;
}

export function workflowDepths(workflow: TeamWorkflow) {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    if (memo.has(id)) return memo.get(id) ?? 0;
    if (path.has(id)) return 0;
    const node = nodes.get(id);
    if (!node || node.dependsOn.length === 0) {
      memo.set(id, 0);
      return 0;
    }
    const nextPath = new Set(path).add(id);
    const depth = Math.max(
      0,
      ...node.dependsOn.map((dependency) => visit(dependency, nextPath) + 1),
    );
    memo.set(id, depth);
    return depth;
  };
  for (const node of workflow.nodes) visit(node.id, new Set());
  return memo;
}

function normalizeWorkflow(value: unknown): TeamWorkflow | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<TeamWorkflow>;
  const id = cleanId(String(item.id ?? ''));
  if (!id || !Array.isArray(item.nodes)) return null;
  const nodes = item.nodes.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const node = raw as Partial<TeamWorkflowNode>;
    const nodeId = cleanId(String(node.id ?? ''));
    if (!nodeId) return [];
    return [{
      id: nodeId,
      title: String(node.title ?? nodeId),
      prompt: String(node.prompt ?? ''),
      dependsOn: Array.isArray(node.dependsOn)
        ? node.dependsOn.map((dependency) => cleanId(String(dependency))).filter(Boolean)
        : [],
      validation: String(node.validation ?? ''),
    }];
  });
  return {
    protocol: teamWorkflowProtocol,
    id,
    name: String(item.name ?? id),
    description: String(item.description ?? ''),
    version: Math.max(1, Number(item.version) || 1),
    updatedAt: String(item.updatedAt ?? new Date().toISOString()),
    nodes: nodes.length > 0 ? nodes : [createTeamWorkflowNode('entry', 'Start')],
  };
}

function seededWorkflows(): TeamWorkflow[] {
  const release = createTeamWorkflow('Release Check');
  release.id = 'release-check';
  release.description = 'Inspect, verify, and summarize a project release.';
  release.nodes = [
    {
      id: 'inspect',
      title: 'Inspect project',
      prompt: 'Inspect the project structure, build configuration, dependencies, and current changes.',
      dependsOn: [],
      validation: 'List concrete risks and the evidence for each finding.',
    },
    {
      id: 'verify-ui',
      title: 'Verify interface',
      prompt: 'Open the built application and verify layout, interaction, and console output.',
      dependsOn: ['inspect'],
      validation: 'Report tested viewports and visible failures.',
    },
    {
      id: 'release-decision',
      title: 'Release decision',
      prompt: 'Summarize all upstream evidence and make a clear release decision.',
      dependsOn: ['inspect', 'verify-ui'],
      validation: 'Return a release or block decision with reasons.',
    },
  ];
  const research = createTeamWorkflow('Research Brief');
  research.id = 'research-brief';
  research.description = 'Gather independent evidence before synthesis.';
  research.nodes = [
    { id: 'sources', title: 'Source research', prompt: 'Find primary sources relevant to the task.', dependsOn: [], validation: 'Every claim has a source.' },
    { id: 'counterpoint', title: 'Counterpoint', prompt: 'Find credible evidence that challenges the initial framing.', dependsOn: [], validation: 'Include at least one meaningful contradiction.' },
    { id: 'synthesis', title: 'Synthesis', prompt: 'Reconcile upstream evidence into a concise decision brief.', dependsOn: ['sources', 'counterpoint'], validation: 'Separate facts, inference, and uncertainty.' },
  ];
  return [release, research];
}

function uniqueWorkflowId(name: string) {
  const base = cleanId(name) || 'workflow';
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

function cleanId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function yamlScalar(value: string) {
  return JSON.stringify(value);
}

function yamlBlock(value: string, indent = 2) {
  const prefix = ' '.repeat(indent);
  const normalized = value.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  return (lines.length > 0 ? lines : ['']).map((line) => `${prefix}${line}`);
}
