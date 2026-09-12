import { APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND, GET_RUNTIME_TEAM_SNAPSHOT_COMMAND } from '@cardbush/bush-protocol';
import { runtimeExtensionOwner, type RuntimeExtensionFactory } from '@cardbush/bush-runtime';
import { TeamSnapshotStore } from './teamSnapshotStore.js';
import { registerTeamTool } from './teamTool.js';

export const TEAM_EXTENSION_ID = 'team';

/** Plugin implementation; the desktop loads only the installed entry bundle. */
export const createTeamRuntimeExtension: RuntimeExtensionFactory = api => {
  const teams = new TeamSnapshotStore({ canApply: () => !api.hasActiveTurns() });
  registerTeamTool(api.tools, teams, api.subagentTasks, api.runChild, {
    permissionPolicy: api.permissionPolicy,
    registrationOwner: runtimeExtensionOwner(TEAM_EXTENSION_ID),
  });
  return {
    id: TEAM_EXTENSION_ID,
    features: ['product_team_snapshot', 'team_concurrent_execution'],
    commands: {
      [APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND]: payload => teams.apply(payload),
      [GET_RUNTIME_TEAM_SNAPSHOT_COMMAND]: () => teams.result() ?? null,
    },
  };
};

export * from './teamSnapshotStore.js';
export * from './teamTool.js';
