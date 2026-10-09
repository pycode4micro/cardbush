import { useEffect, useSyncExternalStore } from 'react';
import { AGENT_REGISTRY_COMMAND, TEAM_WORKFLOW_COMMAND, type RegisteredAgent, type TeamWorkflow, type TeamRun, type DefinitionReceipt } from '@cardbush/bush-protocol';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import { teamReferenceInstructions } from '../../shared/promptReferences';

type Workspace = { agents: DefinitionReceipt<RegisteredAgent>[]; teams: DefinitionReceipt<TeamWorkflow>[]; runs: TeamRun[]; selectedId: string; loading: boolean; error: string };
const listeners = new Set<() => void>();
let snapshot: Workspace = { agents: [], teams: [], runs: [], selectedId: '', loading: false, error: '' };
let pending: Promise<void> | undefined;
function publish(change: Partial<Workspace>) { snapshot = { ...snapshot, ...change }; listeners.forEach(listener => listener()); }
export async function teamCommand<T = unknown>(kind: typeof AGENT_REGISTRY_COMMAND | typeof TEAM_WORKFLOW_COMMAND, payload: unknown): Promise<T> {
  const session = createDesktopRuntimeSession();
  try { return await session.client.command({ kind, payload }, value => value as T); }
  finally { session.dispose(); }
}
export function refreshTeamWorkspace() {
  if (pending) return pending;
  publish({ loading: true });
  pending = Promise.all([
    teamCommand<DefinitionReceipt<RegisteredAgent>[]>(AGENT_REGISTRY_COMMAND, { action: 'list' }),
    teamCommand<{ teams: DefinitionReceipt<TeamWorkflow>[]; runs: TeamRun[] }>(TEAM_WORKFLOW_COMMAND, { action: 'list' }),
  ]).then(([agents, result]) => {
    publish({ agents, ...result, loading: false, error: '', selectedId: result.teams.some(team => team.definition.id === snapshot.selectedId) ? snapshot.selectedId : '' });
  }).catch(error => publish({ loading: false, error: error instanceof Error ? error.message : String(error) })).finally(() => { pending = undefined; });
  return pending;
}
export function selectTeam(id: string) { publish({ selectedId: id }); }
export function useTeamWorkspace(enabled = true) {
  useEffect(() => { if (enabled) void refreshTeamWorkspace(); }, [enabled]);
  const state = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
  return { ...state, title: 'Team', command: enabled ? 'team' : '',
    choices: state.teams.map(({ definition }) => ({ id: definition.id, name: definition.name, description: definition.description })),
    instructions: enabled && state.selectedId ? teamReferenceInstructions(state.selectedId) : '',
  };
}
