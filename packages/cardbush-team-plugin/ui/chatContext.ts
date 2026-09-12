/** Selection supplies context; the model decides whether the request needs delegation. */
export function teamModeContextPrompt() {
  return 'The user selected an optional Team plugin configuration. Use only capabilities actually exposed by that plugin; selecting a Team does not itself request execution.';
}
