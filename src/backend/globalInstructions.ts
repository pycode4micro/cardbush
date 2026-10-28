import { uiText } from '../i18n';
export interface GlobalInstructionsSnapshot {
  path: string;
  content: string;
  revision: string;
}

export async function readGlobalInstructions(): Promise<GlobalInstructionsSnapshot> {
  const read = window.cardbushDesktop?.readGlobalInstructions;
  if (!read) throw new Error(uiText()('globalInstructions.global_agents_md_bridge_is_unavailable'));
  return read();
}

export async function saveGlobalInstructions(content: string, revision: string): Promise<GlobalInstructionsSnapshot> {
  const save = window.cardbushDesktop?.saveGlobalInstructions;
  if (!save) throw new Error(uiText()('globalInstructions.global_agents_md_bridge_is_unavailable'));
  return save(content, revision);
}

export async function readAgentInstructions(projectDir?: string, workspaceDir?: string) {
  const read = window.cardbushDesktop?.readAgentInstructions;
  if (!read) throw new Error(uiText()('globalInstructions.agents_md_instruction_bridge_is_unavailable'));
  return read(projectDir, workspaceDir);
}
