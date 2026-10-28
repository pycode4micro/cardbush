import { uiText } from '../../i18n';
/** Keep IPC envelopes and filesystem diagnostics out of canvas notifications. */
export function canvasErrorMessage(error: unknown, language: string) {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').replace(/^Error:\s*/, '');
  if (/\b(?:ENOENT|ENOTDIR)\b/.test(message)) {
    const path = message.match(/\b(?:stat|open|lstat|realpath|scandir)\s+['"](.+?)['"]/)?.[1];
    const name = path?.split(/[\\/]/).pop();
    return uiText(language)('canvasErrors.cannotFindCheckWhetherItWasMoved', { value1: (name ? uiText(language)('canvasErrors.message', { value1: name }) : uiText(language)('canvasErrors.theReferencedFile')) });
  }
  if (/\b(?:EACCES|EPERM)\b/.test(message)) return uiText(language)('canvasErrors.cannotAccessTheFileCheckItsPermissions');
  return message.replace(/^CANVAS_[A-Z_]+:\s*/, '');
}
