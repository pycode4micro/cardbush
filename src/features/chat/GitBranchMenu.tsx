import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [repositoryAvailable, setRepositoryAvailable] = useState(false);
  const readSequence = useRef(0);

  const reload = useCallback(async () => {
    const sequence = ++readSequence.current;
    setRepositoryAvailable(false);
    setBranches([]);
    setCurrentBranch('');
    const root = activeProjectDir?.trim();
    if (!root || !window.cardbushDesktop?.gitInfo) {
      setLoading(false);
      setStatus(language === 'zh' ? '请先打开一个 Git 项目' : 'Open a Git project first');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const info = await window.cardbushDesktop.gitInfo(root);
      if (sequence !== readSequence.current) return;
      if (info.missing || info.error) {
        setStatus(info.error && !/not a git repository/i.test(info.error) ? info.error : info.missing || /not a git repository/i.test(info.error ?? '')
          ? (language === 'zh' ? '此目录不是 Git 仓库，仍可查看文件工具记录的修改。' : 'This directory is not a Git repository. Recorded file edits are still available for review.')
          : info.error ?? '');
        return;
      }
      const loadedBranches = await window.cardbushDesktop.gitBranches?.(root) ?? [];
      if (sequence !== readSequence.current) return;
      setRepositoryAvailable(true);
      setCurrentBranch(info.branch);
      setBranches(loadedBranches);
    } catch (caught) {
      if (sequence === readSequence.current) setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  }, [activeProjectDir, language]);

  useEffect(() => {
    void reload();
    return () => { readSequence.current++; };
  }, [reload]);

  const switchBranch = useCallback(
    async (branch: string) => {
      const root = activeProjectDir?.trim();
      if (disabled || loading || !repositoryAvailable || !root || !branch.trim()) {
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
    [activeProjectDir, language, reload, disabled, loading, repositoryAvailable, onChanged],
  );

  const createBranch = useCallback(async () => {
    const root = activeProjectDir?.trim();
    const branch = newBranch.trim();
    if (disabled || loading || !repositoryAvailable || !root || !branch) {
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
  }, [activeProjectDir, language, newBranch, reload, disabled, loading, repositoryAvailable, onChanged]);

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
          disabled={disabled || loading || !repositoryAvailable || !activeProjectDir}
          onChange={(event) => setNewBranch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void createBranch();
            }
          }}
          placeholder={language === 'zh' ? '新分支名称' : 'New branch name'}
        />
        <button type="button" disabled={disabled || loading || !repositoryAvailable || !newBranch.trim()} onClick={() => void createBranch()}>
          <Plus size={14} />
          {language === 'zh' ? '创建' : 'Create'}
        </button>
      </div>
      <div className="branch-list">
        {branches.length === 0 && (loading || repositoryAvailable) && (
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
            disabled={disabled || loading || !repositoryAvailable || branch === currentBranch}
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
