# 2026-09-29 MSIX 提交前准备

本次为 Windows 11 x64 的 Store 复审准备。候选包使用发布者提供的正式身份，尚未上传、提交认证或发布。当前源代码版本为 `1.0.0-beta.4`；MSIX 独立使用 `1.0.5.0`，不是 EXE/AppImage 发行版号。

版本显示补充：下列原始候选包的“关于”和“复制环境信息”仍显示源码版本 `1.0.0-beta.4`。已修正源码中的 MSIX 构建流程，后续构建会使用身份文件中的四段版本显示，并同步设置 Electron 的三段版本和 Windows 文件版本；开发运行及其他渠道保留各自的版本号。中英文显示、复制信息、默认版本回退及打包配置测试已通过。此修复尚未重新生成 MSIX，下列文件、哈希及安装/WACK 证据仍对应原始候选包。

## 本次候选包

| 项目 | 值 |
| --- | --- |
| 上传文件 | `release-msix/1.0.5.0-13UXTU/CardBush-1.0.5.0-x64.msix` |
| SHA-256 | `790ce319e3a74873ad22c7cc5250bcfd4a4327b25b0f62c9a04f0fffb54044ff` |
| Package/Identity/Name | `cardbush.cardbush` |
| Package/Identity/Publisher | `CN=3D022FD6-26C7-4164-802D-6684E6F2CCFB` |
| Package/Properties/PublisherDisplayName | `cardbush` |
| 完整包身份 | `cardbush.cardbush_1.0.5.0_x64__4n55t5wh0acn2` |
| PackageFamilyName | `cardbush.cardbush_4n55t5wh0acn2` |
| 最低系统 | `Windows.Desktop` / `10.0.22000.0` / x64 |
| 能力 | 仅 `runFullTrust`；无 `unvirtualizedResources`、虚拟化排除或 Native Messaging 执行别名 |
| Browser Use | 扩展 `1.2.0`，Chrome / Edge，扩展 ID `iibaamkfgackofhhpadgnmgcjkhckeln` |

身份来自本次 Partner Center 截图，并经实际安装后的 Windows package identity API 确认。候选版本在已知 `1.0.4.0` 基础上递增；Partner Center 的最高已用版本仍需发布者在上传前核对。

正式上传包未做本地测试签名。安装验证使用同一个包的独立 `TEST-ONLY-*` 签名副本，不改变上传文件。两包逐文件比较有 345 项完全一致；差异仅为签名时的 `[Content_Types].xml`、`AppxMetadata/CodeIntegrity.cat` 和 `AppxSignature.p7x`。Store 在认证过程中签名，不需要为上传包购买本地测试证书；测试副本和测试证书不得上传。

源码基线为 `102db822c4aa5f8932dda3ca822da97df6e79cc3`，构建包含当时未提交的 Browser Use 和界面改动，不是仅由该提交重建的纯净版本。构建报告记录了工作树有改动。之后修改的提交说明和验证脚本不改变已经生成的应用载荷。

## 已完成的验证

| 检查 | 结果和范围 |
| --- | --- |
| 生产构建 / 前端类型检查 | 通过 |
| 非 UI 发布回归 | 1,396 项：1,391 通过，5 项 POSIX 专属跳过，0 失败；额外契约脚本通过 |
| 设置 UI | Browser Use 双连接、默认选择、Edge 配对、撤销、窄窗口和主题通过；对话样式回归通过 |
| 实际浏览器源级回归 | Chrome 153.0.8010.53 / Edge 154.0.4258.37：读页、填表、点击、截图、切换和隔离通过 |
| 官方 SDK / MakeAppx | SDK 来源和哈希校验、包生成、清单验证及解包通过 |
| 包内容 | 依赖、隐私排除、品牌图标、原生辅助程序边界和 ACL 检查通过 |
| 解包运行 | 界面、运行时、终端、搜索、产品服务和退出通过 |
| WindowsApps 中的安装版运行 | 实际安装路径的界面、运行时、终端、搜索、资源完整性和干净退出通过 |
| 实际安装身份 | `1.0.5.0` 正式包身份正确，扩展 `1.2.0` |
| 实际安装后的浏览器 | Chrome / Edge 同时配对，读页和截图、切换、默认连接不抢占既有会话、隔离、单独撤销通过 |
| 关闭和重启 | 关闭后不自动重连、应用重启保留启用意图、撤销旧凭据、重新配对、移除配置通过 |
| 权限与 DPI | EXE manifest 为 `asInvoker`、`uiAccess=false`、`dpiAware=true/pm`；实际安装进程的 DPI awareness 为 2 |

实际安装测试使用独立应用数据和浏览器配置，不调用付费模型、不发送业务消息、不读取个人浏览器账户。日志中的一次 PowerShell 输出解码提示经独立重跑对应插件市场测试确认通过；不作为业务测试失败忽略。

## WACK 结果

本次对实际安装的 `1.0.5.0` 执行完整 WACK（`PARTIAL_RUN=FALSE`）：24 项中 22 PASS、1 WARNING、1 可选 FAIL，**0 个必测 FAIL**，整体结果为 WARNING。

- `DPIAwarenessValidation` 为必测项，结果 WARNING：工具报告无法处理 EXE 并判断非 DPI aware。原始结果保留；SDK `mt.exe` 从实际安装的 EXE 提取出 `dpiAware=true/pm`，实际进程查询值为 2。两项反证不用于重写 WACK 结果。
- `Blocked executables` 是可选项，结果 FAIL：检测到 Electron、进程辅助程序、ripgrep 等创建进程 API 以及脚本/命令名称。CardBush 的终端和本地 Agent 需要这类进程能力；此项需如实随报告提供，不声称支持 S 模式。
- WACK 的原始 XML、摘要和 EXE manifest 一并保存；本次版本为 `10.0.26100.7705`，不是历史记录使用的另一工具包版本。它没有必测 FAIL，也不等于 Store 审核已通过。

## 系统卸载与测试清理

正常退出后卸载、保持应用和双浏览器连接运行时卸载、终止主进程后卸载，三种场景均通过。每次确认是本次新建的测试安装，使用 Windows `Remove-AppxPackage`；卸载后包注册、整个包数据目录、连接器数据均不存在，Chrome / Edge 连接断开。没有用手动删残留补足通过结果。

卸载前实际检查了 `pairing.json`、`preference.json`、`routes.json`，运行中场景还包含活动的 `bridge.json`；连接器 ACL 仅允许当前用户和 SYSTEM。最终检查没有 Chrome 或 Edge Native Messaging 注册，测试包和包数据均已移除，临时计划任务为 0。

本次临时签名证书信任及其私钥已移除。之后批量清理隔离浏览器配置和测试签名副本时，自动审批返回 `blocked by policy`，没有提供更详细原因，因此这些文件留在忽略的 `tmp/store-preflight-20260929/installed` 中，不纳入提交材料。此限制与 Windows 已通过的包卸载清理测试分开记录。

完整的脱敏证据见 [msix-1.0.5.0-2026-09-29.json](validation/msix-1.0.5.0-2026-09-29.json)。其中所有当前安装测试明确标注管理员环境及 `ordinaryAccountValidation=false`。

## 测试环境及边界

- 本机 Windows 11 Home build 26200；WACK `10.0.26100.7705`。工具包原始结果与实际测试环境一并保留。
- 本机原有 UAC 关闭、Smart App Control 关闭，运行账号带管理员权限。本次未更改系统保护设置。普通权限启动尝试未能建立可用进程，随后显式标记为当前管理员环境验证；不能将结果写成普通账户或安全保护开启环境通过。
- `1.0.3.0 → 1.0.4.0` 升级及历史外部注册清理已有[历史证据](MSIX_INSTALLED_VALIDATION_2026-09-29.md)，但本次没有旧版安装包来复跑到 `1.0.5.0`，不把旧包结果移用。
- 尚未完成：当前包的独立标准用户和跨账户隔离、最低 Windows/浏览器组合、当前包的旧版升级迁移、通知/任务栏人工验收，以及 Store 签名后的安全保护开启环境验收。声明的最低版本不是已完成全矩阵测试的承诺。
- 本次未占用真实桌面执行 Computer Use 点击或输入回归；包内能力和运行时检查不等于完整桌面操作验收。

## 交给发布者的材料

- [审核短说明（英文）](../packaging/msix/notes-for-certification.en.txt)：复制到 Notes for certification。
- [八项问题回复及 runFullTrust 说明](../packaging/msix/store-submission.zh-CN.md)：回应上次认证要求。
- [审核操作指南（英文）](../packaging/msix/reviewer-guide.en.md)：安装扩展、配对、控制、撤销和清理步骤。
- [商店介绍同步段落（中英文）](../packaging/msix/listing-update.zh-CN.md)：Windows 11 要求、Browser Use、数据处理与卸载说明。
- [中英文商店截图](MSIX_STORE_SCREENSHOTS_2026-09-29.md)：各 4 张 1920 × 1080 PNG，附预览、配图说明与 ZIP；使用演示数据，尚未代为上传。
- [整理好的提交材料目录](../release-msix/1.0.5.0-13UXTU/submission-materials/README.zh-CN.md)：短说明、完整回复、审核指南、当前脱敏证据和原始 WACK XML；原始 MSIX 位于该目录上一层。
- 生成目录中的 `SHA256SUMS.txt`、`msix-build-report.json`、`packaged-smoke-report.json`。构建报告是生成时的快照；之后完成的安装与 WACK 结果以本记录和独立验证证据为准。

## 发布者提交时核对

1. 在产品 `9N7XNDD5WRGS` 中确认三项包身份和最高已用版本；若已使用 `1.0.5.0`，先递增版本重新构建验证。
2. 上传原始 `CardBush-1.0.5.0-x64.msix`，核对解析结果为 Windows 11 起、x64、仅 `runFullTrust`。不上传 `TEST-ONLY-*`。
3. 更新商店旧介绍、隐私说明与截图；沿用真实的隐私政策 URL 和支持方式。AI 审核如需模型账户，须在 Partner Center 私密审核信息中提供实际可用的测试方式，不放进仓库。
4. 粘贴本次审核说明、附验证结果并如实保留测试边界，再由发布者点击提交。材料齐备或 WACK 没有必测失败都不等于 Store 已认证。
5. 获得 Store 签名的分发版本后，从商店安装并在保护开启环境验收。这是后续分发验证，不能提前声称完成。

参考：[MSIX 上传规则](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages)、[Store 包签名](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app)、[WACK 必测及可选项](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-desktop-bridge-app-tests)。
