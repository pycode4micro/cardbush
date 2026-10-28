import { uiText } from '../i18n';
import type { AppLanguage, PermissionMode } from '../types';

/** Keep the existing wire values readable by older Agent services. */
export function normalizePermissionMode(value: unknown): PermissionMode {
  return typeof value === 'string' && value.trim() === 'all_free' ? 'all_free' : 'task_free';
}

export function permissionModeOptions(language: AppLanguage): Array<{
  id: PermissionMode; label: string; description: string;
}> {
  return [{ id: 'task_free', label: uiText(language)('permissionModes.askForApproval'), description: uiText(language)('permissionModes.routineFileOperationsUseTheAuthorizedScope') }, { id: 'all_free', label: uiText(language)('permissionModes.fullAccess'), description: uiText(language)('permissionModes.runToolsWithoutRoutineApprovalSubjectTo') }];
}
