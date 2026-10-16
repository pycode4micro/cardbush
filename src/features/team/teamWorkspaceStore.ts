import { useEffect, useSyncExternalStore } from 'react';
import { AGENT_REGISTRY_COMMAND, TEAM_WORKFLOW_COMMAND, type RegisteredAgent, type TeamWorkflow, type TeamRun, type DefinitionReceipt } from '@cardbush/bush-protocol';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import { teamReferenceInstructions } from '../../shared/promptReferences';

type Workspace = { agents: DefinitionReceipt<RegisteredAgent>[]; teams: DefinitionReceipt<TeamWorkflow>[]; runs: TeamRun[]; selectedId: string; loading: boolean; error: string };
const listeners = new Set<() => void>();
let snapshot: Workspace = { agents: [], teams: [], runs: [], selectedId: '', loading: false, error: '' };
let pending: Promise<void> | undefined;
let mutationVersion = 0;
let initialized = false;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const choicesFor = (teams: Workspace['teams']) => teams.map(({ definition }) => ({ id: definition.id, name: definition.name, description: definition.description }));
let choicesSnapshot = { choices: choicesFor(snapshot.teams), selectedId: snapshot.selectedId, loading: snapshot.loading, error: snapshot.error };
function publish(change: Partial<Workspace>) {
  if (Object.entries(change).every(([key, value]) => snapshot[key as keyof Workspace] === value)) return;
  snapshot = { ...snapshot, ...change };
  const choices = change.teams ? choicesFor(change.teams) : choicesSnapshot.choices;
  const nextChoices = { choices: JSON.stringify(choices) === JSON.stringify(choicesSnapshot.choices) ? choicesSnapshot.choices : choices,
    selectedId: snapshot.selectedId, loading: snapshot.loading, error: snapshot.error };
  if (Object.entries(nextChoices).some(([key, value]) => choicesSnapshot[key as keyof typeof choicesSnapshot] !== value)) choicesSnapshot = nextChoices;
  listeners.forEach(listener => listener());
}
/** Polling preserves identities when nothing changed, including large run snapshots. */
function reconcile<T>(before: T[], next: T[], id: (value: T) => string): T[] {
  const previous = new Map(before.map(value => [id(value), value]));
  const result = next.map(value => { const old = previous.get(id(value)); return old && JSON.stringify(old) === JSON.stringify(value) ? old : value; });
  return before.length === result.length && result.every((value, index) => value === before[index]) ? before : result;
}
export function currentTeamWorkflow(id: string) { return snapshot.teams.find(item => item.definition.id === id); }
export function acceptTeamWorkflow(record: DefinitionReceipt<TeamWorkflow>) {
  const before = currentTeamWorkflow(record.definition.id);
  // Graph edits only update existing definitions. A late receipt cannot
  // resurrect a workflow already removed by a newer refresh.
  if (!before || before.revision >= record.revision) return;
  mutationVersion++;
  publish({ teams: snapshot.teams.map(item => item === before ? record : item) });
}
export async function teamCommand<T = unknown>(kind: typeof AGENT_REGISTRY_COMMAND | typeof TEAM_WORKFLOW_COMMAND, payload: unknown): Promise<T> {
  const session = createDesktopRuntimeSession();
  try { return await session.client.command({ kind, payload }, value => value as T); }
  finally { session.dispose(); }
}
export function refreshTeamWorkspace(afterMutation = false, background = false): Promise<void> {
  // A list request started before a save must not hide the saved revision.
  if (pending) return afterMutation ? pending.then(() => refreshTeamWorkspace(false, background)) : pending;
  if (!background || !initialized) publish({ loading: true });
  const version = mutationVersion;
  pending = Promise.all([
    teamCommand<DefinitionReceipt<RegisteredAgent>[]>(AGENT_REGISTRY_COMMAND, { action: 'list' }),
    teamCommand<{ teams: DefinitionReceipt<TeamWorkflow>[]; runs: TeamRun[] }>(TEAM_WORKFLOW_COMMAND, { action: 'list' }),
  ]).then(([agents, result]) => {
    // An older list reply must not roll back a save accepted in the meantime.
    if (version !== mutationVersion) return;
    initialized = true;
    publish({ agents: reconcile(snapshot.agents, agents, value => value.definition.id),
      teams: reconcile(snapshot.teams, result.teams, value => value.definition.id), runs: reconcile(snapshot.runs, result.runs, value => value.id),
      loading: false, error: '', selectedId: result.teams.some(team => team.definition.id === snapshot.selectedId) ? snapshot.selectedId : '' });
  }).catch(error => { if (version === mutationVersion) publish({ loading: false, error: error instanceof Error ? error.message : String(error) }); }).finally(() => { pending = undefined; });
  return pending.then(() => version !== mutationVersion ? refreshTeamWorkspace(false, background) : undefined);
}
export function selectTeam(id: string) { publish({ selectedId: id }); }
export function useTeamWorkspace(enabled = true) {
  useEffect(() => { if (enabled) void refreshTeamWorkspace(false, true); }, [enabled]);
  const state = useSyncExternalStore(subscribe, () => snapshot);
  return { ...state, title: 'Team', command: enabled ? 'team' : '',
    choices: choicesSnapshot.choices,
    instructions: enabled && state.selectedId ? teamReferenceInstructions(state.selectedId) : '',
  };
}

/** The app shell and composers only need choices, not node coordinates or run output. */
export function useTeamChoices(enabled = true) {
  useEffect(() => { if (enabled) void refreshTeamWorkspace(false, true); }, [enabled]);
  const state = useSyncExternalStore(subscribe, () => choicesSnapshot);
  return { ...state, title: 'Team', command: enabled ? 'team' : '',
    instructions: enabled && state.selectedId ? teamReferenceInstructions(state.selectedId) : '' };
}
