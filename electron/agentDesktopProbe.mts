import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';
import { createPlatformContext, findExecutable } from '@cardbush/platform';
import { runResourceManagedCommand, resolveProcessResourceHost } from '@cardbush/bush-runtime/processes';
import type { AgentDesktopSetup } from './agentDesktopTypes.js';
import { readAgentDesktopBridge, inspectAgentDesktopBridge } from './agentDesktopBridge.mjs';

const windowsProbe = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CardBushDesktopProbe { [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access); [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop); }'
$handle=[CardBushDesktopProbe]::OpenInputDesktop(0,$false,1)
$code=if($handle -eq [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::GetLastWin32Error()}else{0}
$accessible=$handle -ne [IntPtr]::Zero
if($accessible){[void][CardBushDesktopProbe]::CloseDesktop($handle)}
@{interactive=[Environment]::UserInteractive; inputDesktop=$accessible; errorCode=$code; sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId} | ConvertTo-Json -Compress
`;
const pythonProbe = `import importlib.util,json,os
modules={m:importlib.util.find_spec(m) is not None for m in ['mss','PIL','playwright']}
browser=False
if modules['playwright']:
 from playwright.sync_api import sync_playwright
 with sync_playwright() as p: browser=os.path.isfile(p.chromium.executable_path)
print(json.dumps({'modules':modules,'browser':browser}))
`;
type Run = (executable: string, args: string[]) => Promise<{ stdout: string; exitCode: number | null }>;

export function findWindowsDesktopPowerShell(env: NodeJS.ProcessEnv, find = (name: string) => findExecutable(name, createPlatformContext({ platform: 'win32', env }))) {
  const programFiles = Object.entries(env).find(([key]) => key.toLowerCase() === 'programfiles')?.[1];
  return find('pwsh.exe') || (programFiles && find(win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')));
}

/** Read-only probes run as the Agent's own account. They never start a desktop/browser or inject input. */
export async function probeAgentDesktop(env: NodeJS.ProcessEnv, seams: {
  platform?: NodeJS.Platform; find?: (name: string) => string | undefined; run?: Run;
} = {}): Promise<AgentDesktopSetup> {
  const platform = seams.platform ?? process.platform;
  const find = seams.find ?? (name => findExecutable(name, createPlatformContext({ platform, env })));
  const run: Run = seams.run ?? ((executable, args) => runResourceManagedCommand({
    executable, args, cwd: fileURLToPath(new URL('..', import.meta.url)), env,
    ...(platform === 'win32' ? { hostPath: resolveProcessResourceHost(env) } : {}),
    timeoutMs: 10_000, maxOutputBytes: 32 * 1024,
  }));
  const report: AgentDesktopSetup = { state: 'needs_setup', environment: 'unknown', backend: platform === 'linux' ? 'available' : 'not_configured',
    checkedAt: new Date().toISOString(), checks: [], summary: '', remediation: [] };
  try {
    if (platform === 'win32') {
      const bridge = readAgentDesktopBridge(env.CARDBUSH_AGENT_DESKTOP_BRIDGE, env.CARDBUSH_SERVICE_ID);
      if (bridge) {
        const remote = await inspectAgentDesktopBridge(bridge);
        return { ...remote, backend: 'not_configured', state: remote.environment === 'ready' ? 'not_enabled' : 'needs_setup',
          checks: [...remote.checks, { id: 'interactive_mcp_bridge', state: remote.environment === 'ready' ? 'ok' : 'blocked' }],
          summary: remote.environment === 'ready'
            ? 'Computer Use MCP 已连接交互用户桌面；内置桌面预览未启用 / interactive Computer Use MCP connected; built-in preview not enabled'
            : remote.summary,
          remediation: remote.environment === 'ready' ? [] : ['恢复桥接用户的交互桌面后重试；主服务继续保留独立账户。'] };
      }
      const powershell = findWindowsDesktopPowerShell(env, find);
      if (!powershell) {
        report.environment = 'missing'; report.checks.push({ id: 'powershell', state: 'missing' });
        report.summary = '当前尚缺 Windows 桌面探测依赖 / Windows desktop probe dependency missing';
        report.remediation.push('请安装 PowerShell 7（pwsh）后重新探测；不支持 Windows PowerShell 5，也不能由此判断主机没有桌面能力。');
      } else {
        const result = await run(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsProbe,'utf16le').toString('base64')]);
        if (result.exitCode !== 0) throw Error('windows_probe_failed');
        const value = JSON.parse(result.stdout);
        if (typeof value.interactive !== 'boolean' || typeof value.inputDesktop !== 'boolean') throw Error('invalid_probe_response');
        report.environment = value.interactive && value.inputDesktop ? 'ready' : 'blocked';
        report.checks.push({ id: 'interactive_session', state: value.interactive ? 'ok' : 'blocked' },
          { id: 'windows_session', state: value.interactive ? 'ok' : 'blocked', code: String(value.sessionId) },
          { id: 'input_desktop_access', state: value.inputDesktop ? 'ok' : 'blocked', ...(value.errorCode ? {code:String(value.errorCode)} : {}) });
        report.summary = report.environment === 'ready'
          ? '已探测到可访问的 Windows 桌面；当前 Agent 尚未接入桌面控制后端 / desktop detected, Agent backend not configured'
          : '当前 Agent 账户尚不能访问可交互桌面 / current Agent account cannot access an interactive desktop';
        report.remediation.push('为 Agent 配置获准访问的交互用户会话及桌面控制后端，再复测；后台服务账户与登录桌面可能属于不同会话。');
      }
    } else if (platform === 'linux') {
      const commands = new Map(['xdpyinfo','xdotool','xclip','Xvfb'].map(name => [name, find(name)]));
      const python = find(env.CARDBUSH_DESKTOP_PYTHON || 'python3');
      for (const [name, path] of commands) report.checks.push({ id: name, state: path ? 'ok' : 'missing' });
      report.checks.push({ id: 'python', state: python ? 'ok' : 'missing' });
      let displayReady = false;
      if (env.DISPLAY && commands.get('xdpyinfo')) displayReady = (await run(commands.get('xdpyinfo')!, ['-display',env.DISPLAY])).exitCode === 0;
      report.checks.push({ id: 'display_access', state: displayReady ? 'ok' : env.DISPLAY ? 'blocked' : 'missing' });
      if (python) {
        const result = await run(python, ['-c',pythonProbe]);
        if (result.exitCode !== 0) throw Error('python_desktop_probe_failed');
        const value = JSON.parse(result.stdout);
        for (const name of ['mss','PIL','playwright']) report.checks.push({ id:name, state:value.modules?.[name] === true ? 'ok':'missing' });
        report.checks.push({ id:'chromium', state:value.browser === true ? 'ok':'missing' });
      }
      // Xvfb is an optional remedy; an accessible existing X display needs no virtual display.
      const ready = report.checks.filter(check => check.id !== 'Xvfb').every(check => check.state === 'ok');
      report.environment = ready ? 'ready' : report.checks.some(check => check.state === 'blocked') ? 'blocked' : 'missing';
      report.state = ready ? 'not_enabled' : 'needs_setup';
      report.summary = ready ? '桌面依赖与显示连接已就绪，尚未启用 / desktop ready to enable'
        : '当前桌面环境尚未就绪，可补齐依赖或显示连接 / desktop setup required';
      report.remediation.push(ready ? '使用 --desktop 显式启用；初始化与观测检查通过后开放工具。'
        : '安装缺少的桌面依赖；没有显示服务时可使用 Xvfb，配置 DISPLAY/XAUTHORITY 后复测。现有 Personal Agent desktop 镜像已包含这些组件。');
    } else {
      report.state = 'probe_failed'; report.summary = '此平台尚无已接入的探测器，桌面能力未确认 / desktop capability not yet probed';
      report.remediation.push('接入目标平台的探测与控制后端后复测；未探测不等于没有桌面能力。');
    }
  } catch (error) {
    report.state = 'probe_failed'; report.environment = 'unknown';
    report.checks.push({ id:'probe', state:'blocked', code:(error as NodeJS.ErrnoException).code || 'probe_failed' });
    report.summary = '桌面探测未完成，能力尚未确认 / desktop probe did not complete';
    report.remediation.push('检查进程保护组件、依赖和当前账户权限后重试；不要据此认定没有桌面能力。');
  }
  return report;
}
