# Windows 11 Store 连接器复审草稿

更新：2026-09-29。以下说明对应主动配对的 WebSocket 实现，取代旧 Native Messaging 方案。新暂存包版本为 `1.0.4.0`；最终包安装与卸载证据仍待补齐，尚未重提认证。提交前核对 Partner Center 最高版本，附实际新包 SHA-256，不能沿用旧包测试结论。

## 受限能力

**runFullTrust**: CardBush is an Electron desktop application. It runs a local agent runtime, accesses user-selected workspaces, launches local command processes, and provides user-directed desktop and browser automation. Windows permissions and security policy continue to apply; this capability does not grant administrator privileges.

**unvirtualizedResources has been removed.** The connector no longer creates a Native Messaging registration and no longer needs a registry or filesystem virtualization exception. It does not install a background cleanup service, driver or custom uninstall action.

## 微软八项问题：按新架构说明

### 1. Identity and locations

The optional connector pairs with Chrome extension `iibaamkfgackofhhpadgnmgcjkhckeln`. The desktop Broker listens only on `127.0.0.1` at a randomly allocated port persisted in the package's private connector configuration. The extension initiates the connection after explicit pairing.

Connector configuration is stored under `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalState\browser-connector`: `preference.json`, `pairing.json`, and the active `bridge.json`. The package family is obtained from the Windows package identity API. Attach the exact tested path, without configuration contents or credentials.

The source-built helper at `<PackageInstallLocation>\app\resources\chrome-native-host\CardBushBrowserHost.exe` is used by the app for Windows ACL validation, package identity and read-only legacy-registration queries. It is no longer registered as a Chrome native host or exposed through an execution alias.

### 2. Restricted capability scope

The previous `unvirtualizedResources` capability and `virtualization:ExcludedKey` have been removed. The current connector has no registry creation API. Its legacy migration code can identify existing records and, only outside the package, remove the fixed owned legacy default value. It never overwrites another installation's registration.

### 3. System-wide changes

No HKLM writes, system-directory modifications, service/driver installation or elevation are performed by the connector. No public-network listener is created. Configuration and the private MCP pipe have access controls for the current Windows user and SYSTEM, checked with native Windows APIs.

### 4. Virtualization

The MSIX uses normal registry and filesystem virtualization without connector exclusions. No external Native Messaging manifest or registry entry is required for the new connection. Package-owned LocalState replaces the old virtualized Roaming location. Installed-package removal tests must confirm the observed cleanup behavior.

### 5. Windows versions

The package supports Windows 11 x64 starting at build 22000. Windows 10 is excluded by the minimum package version and the application startup check. There is no Windows 10 package-wide virtualization fallback. The tested extension target is Chrome 116 or later; other browsers are not claimed as validated.

### 6. Third-party data and authentication

The WebSocket upgrade is restricted to the exact extension Origin, loopback address, Host and path, with a credential proof before upgrade. A subsequent mutual HMAC challenge authenticates the Broker and extension before browser commands can flow. Pairing codes expire after five minutes; a completed new pairing invalidates the previous pairing. Timeouts, connection limits and heartbeat checks bound idle connections.

Pairing does not grant page access. Existing page-consent controls and per-session tab groups remain. The extension uses browser APIs, including debugger APIs, on authorized pages; it does not directly scan Chrome password or cookie databases. Authorized page text, screenshots and action results may be processed by the user's configured model service. This description does not limit the desktop application's separate user-directed workspace and terminal tools.

### 7. Persistence and uninstall

Ordinary app exit closes live connections and removes the active bridge file, retaining private pairing and enabled intent. Explicit Disable or Remove stops the Broker, revokes pairing credentials and persists a disabled marker. Neither creates a Chrome registry entry.

For new installations, connector configuration is package-owned LocalState. Final-package normal, running and post-crash uninstall tests remain pending; no zero-residue result is claimed before these tests. User workspace files and the independently installed Chrome extension are intentionally outside connector cleanup.

Older releases may have left an external Native Messaging key. Packaged deletion can be virtualized and therefore is not reported as successful external cleanup. CardBush detects verified legacy records and offers a fixed cleanup command to run after exiting CardBush, in an ordinary unpackaged Windows Terminal PowerShell. The script validates paths and ownership, rejects live instances and redirected paths, preserves unrelated values/files, and supports a dry run. Existing unverified records are reported, never silently removed.

### 8. User control and reconnection

Both sides default to disabled. CardBush provides enable, generate pairing code, disable, remove configuration and diagnostics controls. The extension provides pair/connect, stop control, revoke page authorization and disable connection. A fresh browser session requires an explicit Connect action. Within an enabled browser session, worker recovery uses bounded retry/backoff. Disabling revokes the desktop credential even when the extension is offline, preventing an old connection from regaining control after restart.

## 提交前必须补充

- 最终包版本、SHA-256、包身份、实际 LocalState 路径；确认清单无 `unvirtualizedResources`、虚拟化排除或 execution alias。
- 安装签名副本、真实 Chrome 读页/停止/关闭、重启、升级、旧版迁移、端口冲突和跨账户验证。
- 正常、运行中、崩溃后卸载的真实残留列表，Windows App Certification Kit 结果。
- 正式 Store 签名分发包在系统保护开启环境的运行验证。本机 SAC 关闭时的开发结果不能替代此项。

包格式检查和开发测试不等于通过商店认证。参见 [实施记录](../../docs/MSIX_CONNECTOR_REMEDIATION_PLAN_2026-09-28.md)、[微软虚拟化说明](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)、[Chrome WebSocket 扩展说明](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)。
