import type { Terminal as XTermInstance } from '@xterm/xterm';
import {
  ChevronDown,
  Plus,
  Terminal,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { compactPath } from '../../shared/localPaths';
import type { AppLanguage, TerminalRuntime } from '../../types';

export type ConsoleMode = 'terminal';

type TerminalSessionInfo = {
  id: string;
  cwd: string;
  shell: string;
};

type TerminalTab = {
  key: number;
  session: TerminalSessionInfo | null;
};

export function ConsoleDock({
  language,
  activeProjectDir,
  terminalRuntime,
  onClose,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
  terminalRuntime: TerminalRuntime;
  onClose: () => void;
}) {
  const terminalTitle = language === 'zh' ? '终端控制台' : 'Terminal console';

  return (
    <section className="console-dock terminal">
      <header className="console-header">
        <Terminal size={16} />
        <strong>{terminalTitle}</strong>
        <span>
          {activeProjectDir || (language === 'zh' ? '当前工作区' : 'Current workspace')}
        </span>
        <button type="button" onClick={onClose} aria-label="close console">
          <ChevronDown size={18} />
        </button>
      </header>
      <EmbeddedTerminal
        language={language}
        activeProjectDir={activeProjectDir}
        terminalRuntime={terminalRuntime}
      />
    </section>
  );
}

function EmbeddedTerminal({
  language,
  activeProjectDir,
  terminalRuntime,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
  terminalRuntime: TerminalRuntime;
}) {
  const nextTabKeyRef = useRef(2);
  const [tabs, setTabs] = useState<TerminalTab[]>([{ key: 1, session: null }]);
  const [activeTabKey, setActiveTabKey] = useState<number | null>(1);

  const addTerminal = () => {
    const key = nextTabKeyRef.current;
    nextTabKeyRef.current += 1;
    setTabs((current) => [...current, { key, session: null }]);
    setActiveTabKey(key);
  };

  const closeTerminal = (key: number) => {
    const index = tabs.findIndex((tab) => tab.key === key);
    if (index < 0) {
      return;
    }
    const remaining = tabs.filter((tab) => tab.key !== key);
    setTabs(remaining);
    if (activeTabKey === key) {
      setActiveTabKey(remaining[Math.min(index, remaining.length - 1)]?.key ?? null);
    }
  };

  const updateSession = (key: number, session: TerminalSessionInfo | null) => {
    setTabs((current) => current.map((tab) => (tab.key === key ? { ...tab, session } : tab)));
  };

  return (
    <div className="console-content terminal native-terminal-shell">
      <div className="native-terminal-tabs" role="tablist">
        {tabs.map((tab, index) => (
          <div
            className={`native-terminal-tab ${activeTabKey === tab.key ? 'active' : ''}`}
            key={tab.key}
          >
            <button
              className="native-terminal-tab-select"
              type="button"
              role="tab"
              aria-selected={activeTabKey === tab.key}
              onClick={() => setActiveTabKey(tab.key)}
            >
              <Terminal size={14} />
              <span>
                {compactPath(tab.session?.cwd ?? activeProjectDir)
                  ? `${compactPath(tab.session?.cwd ?? activeProjectDir)}${
                      tabs.length > 1 ? ` · ${index + 1}` : ''
                    }`
                  : language === 'zh'
                    ? `终端 ${index + 1}`
                    : `Terminal ${index + 1}`}
              </span>
            </button>
            <button
              className="native-terminal-tab-close"
              type="button"
              aria-label={language === 'zh' ? '关闭终端' : 'Close terminal'}
              title={language === 'zh' ? '关闭并结束该终端' : 'Close and terminate this terminal'}
              onClick={() => closeTerminal(tab.key)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          className="native-terminal-add"
          type="button"
          aria-label={language === 'zh' ? '新建终端' : 'New terminal'}
          title={language === 'zh' ? '新建终端' : 'New terminal'}
          onClick={addTerminal}
        >
          <Plus size={16} />
        </button>
      </div>
      {tabs.length === 0 && (
        <button className="native-terminal-empty" type="button" onClick={addTerminal}>
          <Plus size={18} />
          {language === 'zh' ? '新建终端' : 'New terminal'}
        </button>
      )}
      {tabs.map((tab) => (
        <TerminalSessionView
          key={tab.key}
          active={activeTabKey === tab.key}
          language={language}
          activeProjectDir={activeProjectDir}
          terminalRuntime={terminalRuntime}
          onSessionChange={(session) => updateSession(tab.key, session)}
        />
      ))}
    </div>
  );
}

function TerminalSessionView({
  active,
  language,
  activeProjectDir,
  terminalRuntime,
  onSessionChange,
}: {
  active: boolean;
  language: AppLanguage;
  activeProjectDir?: string;
  terminalRuntime: TerminalRuntime;
  onSessionChange: (session: TerminalSessionInfo | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeToContainerRef = useRef<(() => void) | null>(null);
  const onSessionChangeRef = useRef(onSessionChange);
  const [status, setStatus] = useState('');
  onSessionChangeRef.current = onSessionChange;

  useEffect(() => {
    if (!active) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      resizeToContainerRef.current?.();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

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
      resizeToContainerRef.current = resizeToContainer;

      resizeObserver = new ResizeObserver(resizeToContainer);
      resizeObserver.observe(terminalContainer);
      resizeToContainer();

      window.cardbushDesktop
        .terminalCreate(activeProjectDir, terminalRuntime)
        .then((nextSession) => {
          if (disposed) {
            void window.cardbushDesktop?.terminalClose(nextSession.id);
            return;
          }
          sessionIdRef.current = nextSession.id;
          onSessionChangeRef.current(nextSession);
          setStatus('');
          resizeToContainer();
          if (active) {
            terminal?.focus();
          }
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
      resizeToContainerRef.current = null;
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
  }, [activeProjectDir, language, terminalRuntime]);

  return (
    <div className={`native-terminal-session ${active ? 'active' : ''}`}>
      <div className="native-terminal-viewport" ref={containerRef} />
      {status && <div className="native-terminal-status">{status}</div>}
    </div>
  );
}


