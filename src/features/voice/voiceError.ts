/** Electron prefixes rejected IPC messages with an internal channel name. */
export function voiceError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method 'voice:[^']+': (?:Error: )?/, '') : fallback;
}
