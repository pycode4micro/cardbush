export type AppLanguage = 'zh' | 'en';
export const AGENT_PROFILE_PROTOCOL = 'bush.agent_profile.v1';
export const TEAM_CONFIGURATION_PROTOCOL = 'bush.team.v1';

export interface AgentProfileDefinition {
  protocol: typeof AGENT_PROFILE_PROTOCOL | string;
  id: string;
  name: string;
  description: string;
  disabledTools: string[];
  skills?: string[];
  hooks: string[];
  guards: string[];
  prompts: {
    instructions: string;
  };
}

export interface TeamMemberDefinition {
  id: string;
  agentProfileId: string;
  responsibility: string;
  fallback: boolean;
}

export interface TeamDefinition {
  protocol: typeof TEAM_CONFIGURATION_PROTOCOL | string;
  id: string;
  name: string;
  description: string;
  members: TeamMemberDefinition[];
}

export interface TeamConfigurationCapabilities {
  available: boolean;
  teamProtocol: string;
  agentProfileProtocol: string;
  contextProtocol: string;
  delegationTool: string;
  ordinarySubagentProfileArgument: boolean;
  memberCapabilities: string[];
  toolPolicy: string;
  fallbackMemberRequired: boolean;
  fixedDag: boolean;
  profileOnlyHooks: Array<{ id: string; event: string }>;
}
