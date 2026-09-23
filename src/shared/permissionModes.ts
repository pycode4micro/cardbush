import type { AppLanguage, PermissionMode } from '../types';

/** Keep the existing wire values readable by older Agent services. */
export function normalizePermissionMode(value: unknown): PermissionMode {
  return typeof value === 'string' && value.trim() === 'all_free' ? 'all_free' : 'task_free';
}

export function permissionModeOptions(language: AppLanguage): Array<{
  id: PermissionMode; label: string; description: string;
}> {
  return language === 'zh' ? [
    { id: 'task_free', label: '申请批准', description: '常规文件操作在授权范围内执行，额外访问和未隔离的命令执行需要批准。' },
    { id: 'all_free', label: '完全访问', description: '工具操作无需常规审批，仍遵守宿主强制限制。' },
  ] : [
    { id: 'task_free', label: 'Ask for approval', description: 'Routine file operations use the authorized scope. Additional access and unsandboxed commands require approval.' },
    { id: 'all_free', label: 'Full access', description: 'Run tools without routine approval, subject to enforced host restrictions.' },
  ];
}
