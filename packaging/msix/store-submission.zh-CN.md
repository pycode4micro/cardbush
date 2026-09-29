# Windows 11 Store 复审材料

更新：2026-09-29。适用当前 Browser Use / 扩展 1.2.0，支持 Windows 11 x64 上的 Chrome 和 Edge。本文回应上次认证的八项问题；上传与点击「提交认证」由发布者自行完成。

## 文件与填写位置

| 材料 | 用途 |
| --- | --- |
| [英文短说明](notes-for-certification.en.txt) | Partner Center → Additional Testing Info → 认证说明／说明（Notes for certification），完整替换原文后点击 Save description |
| 下方 runFullTrust 说明 | Restricted capabilities 中的能力用途说明 |
| 下方八项回复 | 审核人员要求的完整架构说明，可作为补充材料 |
| [英文操作指南](reviewer-guide.en.md) | 审核人员安装扩展、配对和验证用户控制的步骤 |
| [商店介绍同步内容](listing-update.zh-CN.md) | 系统要求、浏览器功能和隐私／卸载说明的中英文替换段落 |
| [本次准备记录](../../docs/MSIX_SUBMISSION_PREPARATION_2026-09-29.md) | 当前包、验证结果及仍待完成项目 |
| [1.0.4.0 历史安装证据](../../docs/MSIX_INSTALLED_VALIDATION_2026-09-29.md) | 仅证明旧包的安装、迁移和卸载，不能替代当前包验证 |

原审核报告中的产品 ID 为 `9N7XNDD5WRGS`，审核日期为 2026-09-28。产品 ID 不是 MSIX 的 Publisher 或 Package/Identity/Name；构建必须使用 Partner Center 的精确包身份。当前最低版本为 `10.0.22000.0`，设备族为 `Windows.Desktop`，架构为 x64。

短说明对应本次 `1.0.5.0` 包。请完整替换旧 `1.0.3.0` 的 reconsideration 说明，不要保留“仅补充理由、没有修改代码”的旧结论。保存说明不会改变上传包解析出的受限能力；如仍列出 `unvirtualizedResources`，需另外核对该草稿中的实际包。

## 受限能力

**runFullTrust**: CardBush is an Electron desktop application. It runs a local agent runtime, accesses user-selected workspaces, launches local command processes, and provides user-directed desktop and browser automation. Windows permissions and security policy continue to apply; this capability does not grant administrator privileges. Computer Use is a separate, optional, user-directed desktop capability, not the browser connector.

**unvirtualizedResources has been removed.** The connector no longer creates a Native Messaging registration and no longer needs a registry or filesystem virtualization exception. It does not install a background cleanup service, driver or custom uninstall action.

## 微软八项问题：按新架构说明

### 1. Identity and locations

There is no newly registered Native Messaging host or Native Messaging manifest. The optional connector pairs with CardBush Browser Use extension 1.2.0, ID `iibaamkfgackofhhpadgnmgcjkhckeln`, in Chrome or Edge. The Broker listens only on `127.0.0.1` at a locally allocated port retained in private pairing configuration. Each browser/profile is paired independently by the user.

Connector configuration is stored under `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalState\browser-connector`. `preference.json` records enable/disable intent; `pairing.json` stores per-connection credentials and the default connection; `routes.json` stores session-to-connection bindings; `bridge.json` is the live local MCP connection descriptor. The package family comes from the Windows package identity API. Attach the exact tested path and package identity, without configuration contents or credentials.

The source-built helper at `<PackageInstallLocation>\app\resources\chrome-native-host\CardBushBrowserHost.exe` is used by the app for Windows ACL validation, package identity and read-only legacy-registration queries. It is no longer registered as a Chrome native host or exposed through an execution alias.

### 2. Restricted capability scope

The previous `unvirtualizedResources` capability and `virtualization:ExcludedKey` have been removed. The current connector has no registry creation API. Its legacy migration code can identify existing records and, only outside the package, remove the fixed owned legacy default value. It never overwrites another installation's registration.

### 3. System-wide changes

No HKLM writes, system-directory modifications, service/driver installation or elevation are performed by the connector. CardBush normally runs unelevated. No public-network listener is created. Configuration and the private MCP pipe have current-user/SYSTEM ACLs checked using native Windows APIs. This does not claim isolation from arbitrary malicious processes already running as the same Windows user.

### 4. Virtualization

The MSIX uses normal registry and filesystem virtualization without connector exclusions. No external Native Messaging manifest or registry entry is required for the new connection. Package-owned LocalState replaces the old virtualized Roaming location. Installed-package removal tests must confirm the observed cleanup behavior.

### 5. Windows versions

The package targets Windows 11 x64 starting at build 22000 (`MinVersion=10.0.22000.0`). Windows 10 is excluded by the manifest and startup checks. There is no Windows 10 package-wide virtualization fallback. Browser Use supports Chrome and Edge. The extension declares a Chromium 116 API minimum; this is not a claim that every minimum browser/OS combination has been tested. The installed 1.0.5.0 candidate was tested with Chrome 153.0.8010.53 and Edge 154.0.4258.37 on Windows 11 build 26200; see the evidence for privilege/security settings and unverified combinations.

### 6. Third-party data and authentication

The WebSocket upgrade is restricted to the exact extension Origin, loopback address, Host and path, with credential proof before upgrade. A mutual HMAC challenge authenticates both sides before commands can flow; browser identity is bound to the proof. Pairing codes expire after five minutes and can be consumed once. A new pending code replaces an unused pending code; completed connections remain independent, up to eight. Timeouts, connection limits and heartbeat checks bound idle connections.

Pairing does not grant blanket personal-tab access. Page consent and per-session tab groups remain. The user selects and authorizes an existing personal page before it is copied into a controlled session group. The extension uses browser APIs, including debugger APIs, on authorized pages; it does not directly scan browser password or Cookie database files. Authorized page text, screenshots and action results may be processed by the user's configured model service. This description does not limit the desktop application's separate user-directed workspace and terminal tools.

Changing the default affects only unbound sessions. Existing sessions stay with their selected connection across default changes and restarts. Disconnect/revocation does not silently select another browser. Switching is explicit and first releases control in the old connected browser. Failed/disconnected actions are not automatically replayed in another browser.

### 7. Persistence and uninstall

Ordinary app exit closes live connections and removes the active bridge file, retaining private pairings, enabled intent and session bindings. Removing one connection revokes only its credential. Disable disconnects all browsers, revokes all pairings, removes live bridge/pairing files and retains a disabled marker; bindings remain to prevent silent reassignment. Remove connector configuration also removes routing bindings. Neither creates a Native Messaging registry entry.

For new installations, connector configuration is package-owned LocalState. The current 1.0.5.0 candidate passed normal, running and post-crash system uninstall tests with both Chrome and Edge paired: package registration, connector data and the complete package data root were absent after Windows removal; both browsers disconnected. No manual residue deletion was used to obtain a passing result. Current tests ran with the host's existing administrator privileges and UAC/Smart App Control off; ordinary-account and protection-enabled validation remain unverified. Exact hash and results are in the accompanying evidence. The 1.0.4.0 upgrade/migration record is historical only. An in-app Remove operation is not a system uninstall test. User-created workspace files, browser profiles and separately installed Chrome/Edge extensions are preserved intentionally. Other Windows users' package registrations/data remain separate.

Older releases may have left an external Native Messaging key. Packaged deletion can be virtualized and therefore is not reported as successful external cleanup. CardBush detects verified legacy records and offers a fixed cleanup command to run after exiting CardBush, in an ordinary unpackaged Windows Terminal PowerShell. The script validates paths and ownership, rejects live instances and redirected paths, preserves unrelated values/files, and supports a dry run. Existing unverified records are reported, never silently removed.

### 8. User control and reconnection

Both sides default to disabled. Under Settings > Browser > Browser Use, CardBush provides enable, browser selection, optional connection labels, pairing codes, default selection, individual removal, disable-all, remove-configuration and diagnostic controls. The extension provides Pair/Connect, Stop control, page-authorization revocation and Disable connection. Remove the extension at `chrome://extensions` or `edge://extensions`.

A fresh browser session requires an explicit Connect action. Within an enabled session, worker recovery uses bounded retry/backoff. Revoked offline credentials are rejected on reconnect. Reload the extension when upgrading to 1.2.0; do not test the current package against an older loaded extension.

## 验证与提交顺序

1. 核对 Partner Center 的精确包身份和最高已用版本；记录最终包 SHA-256、完整包身份及实际 LocalState 路径。不能上传 `TEST-ONLY-*` 或本地测试签名副本。
2. 验证最终安装包的 Chrome/Edge 读页、停止、独立撤销、关闭、重启、升级、旧版迁移、端口冲突和跨账户隔离，以及正常/运行中/崩溃后系统卸载。旧包结果不直接移用到新包。
3. 附本次完整 WACK 结果。当前 `1.0.5.0` 重测为 22 PASS、1 DPI WARNING、1 可选 Blocked executables FAIL，没有必测项 FAIL；DPI 反证为实际安装 EXE manifest 的 `true/pm` 和运行时 `GetProcessDpiAwareness=2`。不把 WARNING 改写成 PASS，不声称支持 S 模式；当前测试是本机既有管理员／保护关闭环境，保留普通账户与保护开启环境的待验收项。
4. 同步商店介绍、系统要求、隐私政策和截图中的 Browser Use/Chrome/Edge 说明。模型调用需要用户配置模型服务；如审核需要完整 AI 流程，在 Partner Center 私密审核信息中提供限额测试方式，不把密钥写进这些文件。
5. 填入短说明、runFullTrust 用途及操作指南，上传后核对实际解析出的能力、x64 架构和最低系统版本，再由发布者提交。
6. Store 认证和签名完成后，从商店安装并在系统保护开启环境验收运行时、Computer Use、终端、搜索和浏览器。此项属于后续发布验收，不与提交前本地测试混淆。

包格式检查和开发测试不等于通过商店认证。参见 [实施记录](../../docs/MSIX_CONNECTOR_REMEDIATION_PLAN_2026-09-28.md)、[MSIX 上传](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages)、[Store 签名](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app)、[WACK 必测与可选项](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-desktop-bridge-app-tests)。
