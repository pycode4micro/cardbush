/** The same actionable failure text survives local execution and the SSH error bridge. */
export function workspaceEditRecoveryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${message} No file was changed. Do not repeat the same failed edit. ` +
    'Use read_file to inspect the current lines and sha256, then provide a unique old_text or use ' +
    'start_line/end_line with expected_sha256 from that read and new_text containing complete replacement lines (including line endings). ' +
    'Omit old_text and replace_all in line mode. Use replace_all only when every match is intended to change.'), { code });
}
