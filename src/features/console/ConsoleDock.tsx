import type { Terminal as XTermInstance } from '@xterm/xterm';
import {
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { compactPath } from '../../shared/localPaths';
import type { AppLanguage } from '../../types';

export type ConsoleMode = 'git' | 'terminal';

type GitInfo = {
  branch: string;
  root: string;
  changedFiles: Array<{ path: string; status: string }>;
  missing?: boolean;
  error?: string;
};

type TerminalSessionInfo = {
  id: string;
  cwd: string;
  shell: string;
};
export function ConsoleDock({
  mode,
  language,
  activeProjectDir,
  onClose,
}: {
  mode: ConsoleMode;
  language: AppLanguage;
  activeProjectDir?: string;
  onClose: () => void;
}) {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [gitError, setGitError] = useState('');
  const [gitLoading, setGitLoading] = useState(false);
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [targetBranch, setTargetBranch] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [gitActionOutput, setGitActionOutput] = useState('');
  const [gitActionLoading, setGitActionLoading] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadGitInfo() {
      if (mode !== 'git') {
        return;
      }
      const root = activeProjectDir?.trim();
      if (!root || !window.cardbushDesktop?.gitInfo) {
        setGitInfo(null);
        setGitError(language === 'zh' ? '请先打开一个 Git 项目' : 'Open a Git project first');
        return;
      }
      setGitLoading(true);
      try {
        const info = await window.cardbushDesktop.gitInfo(root);
        if (cancelled) {
          return;
        }
        setGitInfo(info);
        setGitError(info.error ?? '');
        setTargetBranch(info.branch);
        if (!info.error && window.cardbushDesktop?.gitBranches) {
          const branches = await window.cardbushDesktop.gitBranches(root).catch(() => []);
          if (!cancelled) {
            setGitBranches(branches);
          }
        } else {
          setGitBranches([]);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setGitInfo(null);
        setGitError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setGitLoading(false);
        }
      }
    }
    void loadGitInfo();
    return () => {
      cancelled = true;
    };
  }, [activeProjectDir, gitRefreshKey, language, mode]);

  const terminalTitle = language === 'zh' ? '终端控制台' : 'Terminal console';
  const gitTitle = language === 'zh' ? 'Git 控制台' : 'Git console';
  const canRunGitAction = Boolean(
    mode === 'git' &&
      activeProjectDir?.trim() &&
      gitInfo &&
      !gitInfo.missing &&
      !gitInfo.error,
  );

  const runGitAction = useCallback(
    async (
      action: 'checkout' | 'commit' | 'push',
      runner: () => Promise<{ output?: string; branch?: string } | void>,
    ) => {
      if (!canRunGitAction || gitActionLoading) {
        return;
      }
      setGitActionLoading(action);
      setGitActionOutput('');
      setGitError('');
      try {
        const result = await runner();
        setGitActionOutput(result?.output ?? '');
        setGitRefreshKey((value) => value + 1);
      } catch (error) {
        setGitError(error instanceof Error ? error.message : String(error));
      } finally {
        setGitActionLoading('');
      }
    },
    [canRunGitAction, gitActionLoading],
  );

  const checkoutBranch = useCallback(() => {
    const root = activeProjectDir?.trim();
    const branch = targetBranch.trim();
    if (!root || !branch) {
      setGitError(language === 'zh' ? '请输入要切换的分支' : 'Enter a branch to switch to');
      return;
    }
    void runGitAction('checkout', () => window.cardbushDesktop!.gitCheckout(root, branch));
  }, [activeProjectDir, language, runGitAction, targetBranch]);

  const commitChanges = useCallback(() => {
    const root = activeProjectDir?.trim();
    const message = commitMessage.trim();
    if (!root || !message) {
      setGitError(language === 'zh' ? '请输入提交信息' : 'Enter a commit message');
      return;
    }
    void runGitAction('commit', async () => {
      const result = await window.cardbushDesktop!.gitCommit(root, message);
      setCommitMessage('');
      return result;
    });
  }, [activeProjectDir, commitMessage, language, runGitAction]);

  const pushBranch = useCallback(() => {
    const root = activeProjectDir?.trim();
    if (!root) {
      return;
    }
    void runGitAction('push', () => window.cardbushDesktop!.gitPush(root));
  }, [activeProjectDir, runGitAction]);

  return (
    <section className={`console-dock ${mode}`}>
      <header className="console-header">
        {mode === 'git' ? <GitBranch size={16} /> : <Terminal size={16} />}
        <strong>{mode === 'git' ? gitTitle : terminalTitle}</strong>
        <span>
          {mode === 'git'
            ? gitInfo?.branch || gitError || activeProjectDir || ''
            : activeProjectDir || (language === 'zh' ? '当前工作区' : 'Current workspace')}
        </span>
        {mode === 'git' && (
          <button
            type="button"
            onClick={() => setGitRefreshKey((value) => value + 1)}
            aria-label="refresh git"
            disabled={gitLoading}
          >
            <RefreshCw size={15} />
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="close console">
          <ChevronDown size={18} />
        </button>
      </header>
      {mode === 'git' ? (
        <div className="console-content git">
          {gitInfo ? (
            <>
              <ConsoleRow label={language === 'zh' ? '仓库' : 'Repository'} value={gitInfo.root} />
              <ConsoleRow label={language === 'zh' ? '分支' : 'Branch'} value={gitInfo.branch || 'HEAD'} />
              <ConsoleRow
                label={language === 'zh' ? '变更' : 'Changes'}
                value={
                  gitInfo.changedFiles.length === 0
                    ? language === 'zh'
                      ? '干净'
                      : 'Clean'
                    : language === 'zh'
                      ? `${gitInfo.changedFiles.length} 个文件`
                      : `${gitInfo.changedFiles.length} files`
                }
              />
              {gitError && <p className="console-error">{gitError}</p>}
              {!gitInfo.error && !gitInfo.missing && (
                <div className="git-actions">
                  <div className="git-action-row">
                    <input
                      list="git-branches"
                      value={targetBranch}
                      placeholder={language === 'zh' ? '分支名' : 'Branch name'}
                      onChange={(event) => setTargetBranch(event.currentTarget.value)}
                    />
                    <datalist id="git-branches">
                      {gitBranches.map((branch) => (
                        <option key={branch} value={branch} />
                      ))}
                    </datalist>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(gitActionLoading)}
                      onClick={checkoutBranch}
                    >
                      {gitActionLoading === 'checkout' ? <LoaderCircle size={14} /> : <GitBranch size={14} />}
                      {language === 'zh' ? '切换分支' : 'Switch'}
                    </button>
                  </div>
                  <div className="git-action-row">
                    <input
                      value={commitMessage}
                      placeholder={language === 'zh' ? '提交信息' : 'Commit message'}
                      onChange={(event) => setCommitMessage(event.currentTarget.value)}
                    />
                    <button
                      className="primary-button"
                      type="button"
                      disabled={Boolean(gitActionLoading)}
                      onClick={commitChanges}
                    >
                      {gitActionLoading === 'commit' ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
                      {language === 'zh' ? '提交' : 'Commit'}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(gitActionLoading)}
                      onClick={pushBranch}
                    >
                      {gitActionLoading === 'push' ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
                      {language === 'zh' ? '推送' : 'Push'}
                    </button>
                  </div>
                  {gitActionOutput && <pre className="git-action-output">{gitActionOutput}</pre>}
                </div>
              )}
              {gitInfo.changedFiles.length > 0 ? (
                <div className="git-file-list">
                  {gitInfo.changedFiles.map((file) => (
                    <div className="git-file-row" key={`${file.status}:${file.path}`}>
                      <code>{file.status}</code>
                      <span title={file.path}>{file.path}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="console-empty">
                  {language === 'zh' ? '当前没有未提交变更。' : 'No uncommitted changes.'}
                </p>
              )}
            </>
          ) : (
            <p className="console-empty">
              {gitLoading
                ? language === 'zh'
                  ? '正在读取 Git 信息...'
                  : 'Reading Git info...'
                : gitError}
            </p>
          )}
        </div>
      ) : (
        <EmbeddedTerminal language={language} activeProjectDir={activeProjectDir} />
      )}
    </section>
  );
}

function EmbeddedTerminal({
  language,
  activeProjectDir,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const terminalContainer = container;
    let disposed = false;
    let terminal: XTermInstance | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let writeDisposable: { dispose: () => void } | null = null;
    let resizeDisposable: { dispose: () => void } | null = null;

    async function bootTerminal() {
      const { Terminal: XTerm } = await import('@xterm/xterm');
      if (disposed) {
        return;
      }
      terminal = new XTerm({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.18,
        scrollback: 6000,
        theme: {
          background: '#111111',
          foreground: '#f3f3f3',
          cursor: '#f3f3f3',
          selectionBackground: '#305f9f',
          black: '#111111',
          brightBlack: '#666666',
          red: '#f14c4c',
          green: '#23d18b',
          yellow: '#f5f543',
          blue: '#3b8eea',
          magenta: '#d670d6',
          cyan: '#29b8db',
          white: '#e5e5e5',
          brightWhite: '#ffffff',
        },
      });
      terminal.open(terminalContainer);
      terminalRef.current = terminal;

      if (!window.cardbushDesktop?.terminalCreate) {
        terminal.writeln(
          language === 'zh'
            ? '当前预览环境没有 Electron 终端接口，请在桌面窗口中运行。'
            : 'The Electron terminal API is unavailable in preview. Run the desktop window.',
        );
        return;
      }

      writeDisposable = terminal.onData((data) => {
        const id = sessionIdRef.current;
        if (!id) {
          return;
        }
        window.cardbushDesktop?.terminalWrite(id, data);
      });
      resizeDisposable = terminal.onResize(({ cols, rows }) => {
        const id = sessionIdRef.current;
        if (!id) {
          return;
        }
        window.cardbushDesktop?.terminalResize(id, cols, rows);
      });
      offData = window.cardbushDesktop.onTerminalData((payload) => {
        if (payload.id !== sessionIdRef.current || !terminal) {
          return;
        }
        terminal.write(payload.data);
      });
      offExit = window.cardbushDesktop.onTerminalExit((payload) => {
        if (payload.id !== sessionIdRef.current) {
          return;
        }
        setStatus(
          language === 'zh'
            ? `终端已退出，退出码 ${payload.exitCode ?? '-'}`
            : `Terminal exited with code ${payload.exitCode ?? '-'}`,
        );
      });

      function resizeToContainer() {
        if (!terminal) {
          return;
        }
        const width = Math.max(1, terminalContainer.clientWidth - 18);
        const height = Math.max(1, terminalContainer.clientHeight - 12);
        const cols = Math.max(20, Math.floor(width / 8));
        const rows = Math.max(6, Math.floor(height / 16));
        if (terminal.cols !== cols || terminal.rows !== rows) {
          terminal.resize(cols, rows);
        }
      }

      resizeObserver = new ResizeObserver(resizeToContainer);
      resizeObserver.observe(terminalContainer);
      resizeToContainer();

      window.cardbushDesktop
        .terminalCreate(activeProjectDir)
        .then((nextSession) => {
          if (disposed) {
            void window.cardbushDesktop?.terminalClose(nextSession.id);
            return;
          }
          sessionIdRef.current = nextSession.id;
          setSession(nextSession);
          setStatus('');
          resizeToContainer();
          terminal?.focus();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(message);
          terminal?.writeln(message);
        });
    }

    void bootTerminal()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message);
      });

    return () => {
      disposed = true;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      setSession(null);
      resizeObserver?.disconnect();
      offData?.();
      offExit?.();
      writeDisposable?.dispose();
      resizeDisposable?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      if (id) {
        void window.cardbushDesktop?.terminalClose(id);
      }
    };
  }, [activeProjectDir, language]);

  return (
    <div className="console-content terminal native-terminal-shell">
      <div className="native-terminal-tabs">
        <div className="native-terminal-tab active">
          <Terminal size={14} />
          <span>{compactPath(session?.cwd ?? activeProjectDir)}</span>
        </div>
        <button type="button" aria-label="new terminal tab" disabled>
          <Plus size={16} />
        </button>
      </div>
      <div className="native-terminal-viewport" ref={containerRef} />
      {status && <div className="native-terminal-status">{status}</div>}
    </div>
  );
}

function ConsoleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="console-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}


