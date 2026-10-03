# MSIX 1.0.4.0 安装验证（2026-09-29）

适用范围：本文固定记录 1.0.4.0 / 扩展 1.1.0 的历史证据。后续 Browser Use / Edge / 扩展 1.2.0 的提交准备见 [新记录](MSIX_STORE_RELEASE.md)，不沿用本文 hash 或把本文当成新包测试。

新包的真实 Chrome 连接、停用、升级迁移及三种系统卸载路径通过。WACK 完整执行，结果为 **WARNING**，不是无警告通过；没有必测项 FAIL。此记录不代表 Store 认证完成，`releaseReady: false` 保持不变。

## 包与环境

- 原始提交包为 1.0.4.0；具体构建路径和 SHA-256 仅保留在私有发布记录。
- 测试签名副本及其 SHA-256 仅保留在私有发布记录。签名只用于本机验证，未改动或上传原包。逐项比较业务 payload，文件内容一致；新增签名及目录文件，`[Content_Types].xml` 仅增加相应类型声明并改变 XML 排版。
- Windows 11 家庭版，build 26200；实际 Chrome `153.0.8010.54`；扩展 `1.1.0`；WACK `10.0.28000.2705`。
- 每次启动通过 Windows `GetPackageFullName` 核验进程身份；应用及安装/卸载脚本使用当前账号的普通权限。仅证书信任和 WACK 使用管理员权限。
- 既有测试账号未登录，为它创建 S4U 后台任务被 Windows 拒绝（`0x80070005`）。因此改用当前账号此前不存在的 MSIX 安装和包数据目录，显式指定包内独立应用资料目录，并新建专用 Chrome 资料目录。未使用日常应用或浏览器资料目录，未发送模型请求。

## 实测结果

| 场景 | 实际结果 |
| --- | --- |
| 首次安装 | 默认关闭，无 Broker 监听；显式开启后数据位于包专属 `LocalState/browser-connector` |
| 真实 Chrome 往返 | 通过实际 preload/IPC 开启及配对；生产命名管道 → Broker → 真实扩展完成创建、列出、读取测试页面和关闭标签页 |
| 关闭扩展 | 超过重连 alarm 周期仍不重连；用户显式连接后恢复 |
| 重启浏览器 | 新会话保持断开，显式连接后恢复 |
| 普通退出/重启应用 | 保留显式开启意图及配对，可重新连接 |
| 停用/重新配对 | `bridge.json`、`pairing.json` 删除；重启仍关闭；旧配对拒绝，新配对成功 |
| 应用内移除 | 删除实时配置和配对，保留 `enabled: false, removed: true` 标记 |
| 正常系统卸载 | 在退出前真实配对；卸载后包注册、包数据目录和连接器目录均不存在，Chrome 断开，无 Native Messaging 键 |
| 运行中系统卸载 | 配对及 Broker 仍运行时调用 Windows `Remove-AppxPackage`；系统完成卸载后同样无上述残留。该次系统卸载约 54 秒 |
| 崩溃后系统卸载 | 终止刚启动的应用主进程后卸载；包含遗留 `bridge.json`、配对和开启标记的数据目录全部清除 |
| 旧版升级 | 使用历史 `1.0.3.0` 原包的测试签名副本，真实安装并注册旧主机，再升级为 `1.0.4.0`；数据标记和旧 manifest 保留，新版默认关闭并提示外部旧注册项 |
| 升级后连接器 | 在升级后的包身份下再次通过完整 Chrome 配对、启停、重启和凭据撤销检查 |
| 旧注册项迁移 | 退出应用后，执行新包内未经修改的 `cleanup-legacy.ps1`，实际删除 HKCU 旧默认值和旧 manifest；重复执行成功，外部测试工作文件及 Chrome 资料目录保留 |
| 迁移后卸载 | 新旧连接器文件及当前账号包目录均清除，无旧注册项 |
| 目录权限 | 读回 ACL，仅当前用户和 SYSTEM 有允许项，未向 Users 或 Everyone 开放 |

这里的“系统卸载”通过 Windows 包部署 API 执行，没有使用应用内“移除”代替，也没有手工删除包目录伪造结果。测试浏览器通过 CDP 载入包内未修改的扩展；浏览器控制通过真实连接器执行。

## WACK 警告核对

WACK 为完整运行（`PARTIAL_RUN=FALSE`），24 项：22 PASS、1 WARNING、1 可选 FAIL。

- **DPIAwarenessValidation：WARNING，必测项。** 工具报告无法处理 `CardBush.exe`，继而判为不感知 DPI。用 Microsoft `mt.exe` 提取实际程序 manifest，包含 `dpiAware=true/pm`；对已安装运行的进程调用 `GetProcessDpiAwareness`，返回 `2`（逐显示器感知）。保留工具原始警告及反证，未将它改写为 PASS。
- **已阻止的可执行文件：FAIL，可选项。** 报告命中 Electron、进程守护、ripgrep、libvips 的 `CreateProcessW`，以及包内 shell/命令名称字符串。CardBush 的终端和工具执行本就使用进程启动，不为消除此可选项而删除功能。该项不能作为 Windows S 模式兼容性证明。[微软 Desktop Bridge 测试说明](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-desktop-bridge-app-tests)

清单、资源、品牌、私钥文件检查、特殊用途能力、企业能力等其余检查均通过。没有仅凭 `appcert.exe` 退出码 0 就认定全项通过。

## 清理与边界

当前账号的测试包、包内测试资料及本次创建的旧注册项已卸载/清理；本次两张测试证书的私钥均在签名后删除，临时机器信任已移除，没有留下临时计划任务。原始包和测试报告保留，本次新装的 WACK 保留供后续复验。

本次新建的 Chrome 测试资料目录也保留在本机：自动审批拒绝了递归清理操作，只返回 `blocked by policy`，没有提供进一步原因；未换路径重试删除。

Windows 在部署新版时也更新了既有测试账号的包注册；最终该账号仍注册 `1.0.4.0`，当前账号卸载没有删除它。该账号没有被登录，未重置密码、注销或删除其资料。这个观察只证明包注册按账号保留，**不代替第二账号的交互运行及跨账号访问拒绝测试**。

尚未覆盖：第二账号登录后的隔离实测、Windows 11 最低支持 build/Chrome 最低版本组合、Store 分发签名及系统保护开启环境。旧注册项迁移仍是旧安装的独立步骤，不能承诺“用户不执行迁移也能自动清除所有历史外部项”。未上传或重提 Store。

## 证据与复验

脱敏汇总见 [JSON 验证结果](validation/msix-1.0.4.0-2026-09-29.json)。原始 JSON、WACK XML/日志、测试签名副本保存在本机 `C:\Users\Public\Documents\CardBush-MSIX-Test\20260929-1.0.4.0`，不提交二进制、证书、浏览器资料或凭据。

可复用脚本：`scripts/verify-installed-chrome.mjs`、`scripts/verify-process-package.ps1`、`scripts/verify-msix-uninstall.ps1`。Chrome 脚本接受 JSON 配置路径；配置需指定 executable、expectedPackageFullName、userDataDirectory、connectorDirectory、chromeExecutable、全新的 chromeProfile 及 reportPath。设置 uninstallMode（normal/running/crash）时，还必须提供 ownershipPath；该所有权记录需证明当前 SID、精确包名和测试前不存在的包/数据目录。卸载脚本拒绝不匹配的目标。

测试期间修正了一处测试驱动问题：PowerShell 7 的模块路径传给 Windows PowerShell 5.1 后导致 `Get-Acl` 模块加载失败。现在显式从运行中 PowerShell 的 `$PSHOME` 导入系统模块；修正后重新执行三个卸载场景，未把首次驱动失败当作通过。
