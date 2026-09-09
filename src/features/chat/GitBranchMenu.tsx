import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Plus } from 'lucide-react';
import type { AppLanguage } from '../../types';

export function GitBranchMenu({
  language,
  activeProjectDir,
  disabled = false,
  onChanged,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
  disabled?: boolean;
  onChanged?: () => Promise<void>;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    const root = activeProjectDir?.trim();
    if (!root || !window.cardbushDesktop?.gitInfo) {
      setBranches([]);
      setCurrentBranch('');
      setStatus(language === 'zh' ? '请先打开一个 Git 项目' : 'Open a Git project first');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const [info, loadedBranches] = await Promise.all([
        window.cardbushDesktop.gitInfo(root),
        window.cardbushDesktop.gitBranches?.(root) ?? Promise.resolve([]),
      ]);
      setCurrentBranch(info.branch);
      setBranches(loadedBranches);
      if (info.error || info.missing) {
        setStatus(info.error || (language === 'zh' ? '不是 Git 项目' : 'Not a Git project'));
      }
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [activeProjectDir, language]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const switchBranch = useCallback(
    async (branch: string) => {
      const root = activeProjectDir?.trim();
      if (disabled || !root || !branch.trim()) {
        return;
      }
      setLoading(true);
      setStatus('');
      try {
        const result = await window.cardbushDesktop!.gitCheckout(root, branch);
        setCurrentBranch(result.branch || branch);
        setStatus(result.output || (language === 'zh' ? '已切换分支' : 'Branch switched'));
        await reload();
        await onChanged?.();
      } catch (caught) {
        setStatus(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [activeProjectDir, language, reload, disabled, onChanged],
  );

  const createBranch = useCallback(async () => {
    const root = activeProjectDir?.trim();
    const branch = newBranch.trim();
    if (disabled || !root || !branch) {
      setStatus(language === 'zh' ? '请输入新分支名称' : 'Enter a new branch name');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const result = await window.cardbushDesktop!.gitCreateBranch(root, branch);
      setCurrentBranch(result.branch || branch);
      setNewBranch('');
      setStatus(result.output || (language === 'zh' ? '已创建并切换分支' : 'Branch created'));
      await reload();
      await onChanged?.();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [activeProjectDir, language, newBranch, reload, disabled, onChanged]);

  return (
    <div className="popover-stack git-branch-menu">
      <p>
        {activeProjectDir?.trim()
          ? activeProjectDir
          : language === 'zh'
            ? '请先打开一个 Git 项目'
            : 'Open a Git project first'}
      </p>
      <div className="branch-create-row">
        <input
          value={newBranch}
          disabled={disabled || loading || !activeProjectDir}
          onChange={(event) => setNewBranch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void createBranch();
            }
          }}
          placeholder={language === 'zh' ? '新分支名称' : 'New branch name'}
        />
        <button type="button" disabled={disabled || loading || !newBranch.trim()} onClick={() => void createBranch()}>
          <Plus size={14} />
          {language === 'zh' ? '创建' : 'Create'}
        </button>
      </div>
      <div className="branch-list">
        {branches.length === 0 && (
          <span className="popover-status">
            {loading
              ? language === 'zh'
                ? '正在加载分支...'
                : 'Loading branches...'
              : language === 'zh'
                ? '暂无分支列表'
                : 'No branches found'}
          </span>
        )}
        {branches.map((branch) => (
          <button
            className={`popover-row ${branch === currentBranch ? 'active' : ''}`}
            type="button"
            key={branch}
            disabled={disabled || loading || branch === currentBranch}
            onClick={() => void switchBranch(branch)}
          >
            <GitBranch size={16} />
            <span>
              <strong>{branch}</strong>
              <small>
                {branch === currentBranch
                  ? language === 'zh'
                    ? '当前分支'
                    : 'Current branch'
                  : language === 'zh'
                    ? '切换到此分支'
                    : 'Switch to this branch'}
              </small>
            </span>
          </button>
        ))}
      </div>
      {status && <p className="popover-status">{status}</p>}
    </div>
  );
}
