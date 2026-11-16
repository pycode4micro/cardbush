import { uiText } from '../../i18n';
import { useMemo } from 'react';
import { Check, Circle, LoaderCircle, OctagonAlert, Square } from 'lucide-react';
import type { RegisteredAgent, TeamRun, TeamWorkflow } from '@cardbush/bush-protocol';
import { MdGraphCanvas } from '../mdPresentation/MdGraphCanvas';
import type { MdPosition } from '../mdPresentation/markdownGraph';
import { EmployeeIcon } from './employeePresentation';
import { teamGraphDocument, teamStatusLabel, teamDeliveryLabel } from './teamFlowGraph';
import '../mdPresentation/md-presentation.css';

export function TeamFlowDiagram({ workflow, run, agents, selectedId, onSelect, language, readOnly, saving = false, onPositions, onConnect }: {
  workflow: TeamWorkflow; run?: TeamRun; agents: RegisteredAgent[]; selectedId: string;
  onSelect: (id: string) => void; language: string; readOnly: boolean; saving?: boolean;
  onPositions: (positions: Map<string, MdPosition>) => Promise<void>;
  onConnect: (source: string, target: string) => void;
}) {
  const document = useMemo(() => teamGraphDocument(workflow, agents), [workflow, agents]);
  const status = (id: string) => run?.nodes.find(node => node.id === id)?.status ?? 'idle';
  return <div className="team-flow-viewport md-presentation" aria-label={uiText(language)('teamFlowDiagram.workflowDiagram')}>
    <MdGraphCanvas key={run?.id ?? workflow.id} document={document} selectedId={selectedId} onSelect={onSelect} language={language} flow readOnly={readOnly} saving={saving}
      caption={run ? (uiText(language)('teamFlowDiagram.runSnapshotReadOnlyDragBackgroundTo')) : readOnly ? (uiText(language)('teamFlowDiagram.workflowPreview')) : (uiText(language)('teamFlowDiagram.dragToArrangeConnectDependenciesDragBackground'))}
      icon={() => <EmployeeIcon size={18}/>}
      subtitle={node => {
        const task = workflow.nodes.find(item => item.id === node.id)!;
        return task.name ? agents.find(agent => agent.id === task.agent_id)?.name || task.agent_id : task.id;
      }}
      nodeStatus={node => status(node.id) === 'completed' && run?.nodes.find(item => item.id === node.id)?.delivery?.status !== 'submitted' ? 'paused' : status(node.id)}
      nodeDetail={node => {
        const value = status(node.id), delivery = run?.nodes.find(item => item.id === node.id)?.delivery?.status;
        const Icon = value === 'running' ? LoaderCircle : value === 'failed' || delivery === 'blocked' ? OctagonAlert : value === 'completed' && delivery === 'submitted' ? Check : value === 'stopped' ? Square : Circle;
        return <><Icon size={11}/>{run ? uiText(language)('teamDelivery.states', { execution: teamStatusLabel(value, language), delivery: teamDeliveryLabel(delivery, language) }) : teamStatusLabel(value, language)}</>;
      }}
      onMove={(id, position) => void onPositions(new Map([[id, position]]))} onLayout={onPositions} onConnect={onConnect}/>
  </div>;
}
