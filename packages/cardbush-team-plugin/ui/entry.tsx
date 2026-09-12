import React from 'react';
import { createRoot } from 'react-dom/client';
import type { RuntimeRendererHost, RuntimeRendererExtension, RuntimeRendererSnapshot } from '@cardbush/bush-runtime';
import { setHost, runtimeClient } from './host';
import { TeamPluginWorkspace } from './TeamPluginWorkspace';
import { TeamSidebar } from './TeamSidebar';
import { TeamWorkflowPanel } from './TeamWorkflowPanel';
import { readWorkspaceState, subscribeWorkspace, loadTeamWorkspace, teamWorkspaceActions } from './teamWorkspaceStore';
import { synchronizeProductTeamSnapshot, resetProductTeamConfiguration } from './productTeams';
import { teamModeContextPrompt } from './chatContext';
import css from './team-workflow.css?inline';

export const apiVersion = 1;
export default function activate(host: RuntimeRendererHost): RuntimeRendererExtension<HTMLElement> {
  setHost(host);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const roots = new Set<ReturnType<typeof createRoot>>();
  let snapshot: RuntimeRendererSnapshot;
  const updateSnapshot = () => {
    const state = readWorkspaceState();
    snapshot = { role: 'delegation', command: 'team', title: state.teams.find(team => team.id === state.activeTeamId)?.name || 'Team',
      instructions: teamModeContextPrompt(), selectedId: state.selectedTeamId, loading: state.loading, error: state.error,
      choices: state.teams.map(team => ({ id: team.id, name: team.name, description: team.description || `${team.members.length} Agents` })) };
  };
  updateSnapshot();
  const unsubscribe = subscribeWorkspace(updateSnapshot);
  return {
    apiVersion: 1, getSnapshot: () => snapshot, subscribe: subscribeWorkspace,
    load: loadTeamWorkspace, select: teamWorkspaceActions.selectForNextTurn,
    mount(container, slot, props) {
      const root = createRoot(container); roots.add(root);
      const update = (value: Record<string, unknown>) => {
        const language = value.language === 'en' ? 'en' : 'zh';
        root.render(slot === 'sidebar' ? <TeamSidebar {...value} language={language} /> : slot === 'content'
          ? <TeamWorkflowPanel language={language} workflowValidationAvailable={false} /> : <TeamPluginWorkspace language={language} />);
      };
      update(props);
      return { update, dispose: () => { if (roots.delete(root)) root.unmount(); } };
    },
    async prepareTurn(value, tools) {
      const input = value as { teamId?: string; teamModeEnabled?: boolean };
      if (input.teamId && input.teamModeEnabled) await synchronizeProductTeamSnapshot(runtimeClient, tools as import('@cardbush/bush-protocol').ToolDefinition[]);
    },
    async invoke(action, payload) {
      if (action === 'reset-assets' && Array.isArray(payload) && payload.some(category => category === 'teams' || category === 'agent_profiles')) {
        await host.synchronizeTools();
        await resetProductTeamConfiguration(runtimeClient, await runtimeClient.getToolCatalog());
        await loadTeamWorkspace(true);
        return ['teams', 'agent_profiles'];
      }
    },
    dispose() { unsubscribe(); for (const root of roots) root.unmount(); roots.clear(); style.remove(); },
  };
}
