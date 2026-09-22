/** Electron's IPC wrapper is transport detail; retain the actual Agent error. */
export function agentErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method 'agents:command':\s*(?:Error:\s*)?/, '');
}
