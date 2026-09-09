export interface GlobalInstructionsSnapshot {
  path: string;
  content: string;
  revision: string;
}

export async function readGlobalInstructions(): Promise<GlobalInstructionsSnapshot> {
  const read = window.cardbushDesktop?.readGlobalInstructions;
  if (!read) throw new Error('Global AGENTS.md bridge is unavailable.');
  return read();
}

export async function saveGlobalInstructions(content: string, revision: string): Promise<GlobalInstructionsSnapshot> {
  const save = window.cardbushDesktop?.saveGlobalInstructions;
  if (!save) throw new Error('Global AGENTS.md bridge is unavailable.');
  return save(content, revision);
}

export async function readAgentInstructions(projectDir?: string, workspaceDir?: string) {
  const read = window.cardbushDesktop?.readAgentInstructions;
  if (!read) throw new Error('AGENTS.md instruction bridge is unavailable.');
  return read(projectDir, workspaceDir);
}
