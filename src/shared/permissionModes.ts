import { uiText } from '../i18n';
import type { AppLanguage, PermissionMode } from '../types';

export { approvalMode as normalizePermissionMode } from '@cardbush/bush-protocol';

export function permissionModeOptions(language: AppLanguage): Array<{
  id: PermissionMode; label: string; description: string;
}> {
  return [{ id: 'ask_for_approval', label: uiText(language)('permissionModes.askForApproval'), description: uiText(language)('permissionModes.routineFileOperationsUseTheAuthorizedScope') }, { id: 'all_free', label: uiText(language)('permissionModes.fullAccess'), description: uiText(language)('permissionModes.runToolsWithoutRoutineApprovalSubjectTo') }];
}
