# Microsoft Store MSIX 发布

[English](MSIX_STORE_RELEASE.md) · [简体中文](MSIX_STORE_RELEASE.zh-CN.md)

普通用户从 [Microsoft Store](https://apps.microsoft.com/detail/9N7XNDD5WRGS) 安装，实际可用版本以商店为准。本文用于维护者构建与提交，安装不需要下面的私有身份或签名文件。

采用 **MSIX or PWA app** 提交，Microsoft 托管、签名并分发更新，NSIS/EXE 与 Linux 是独立渠道。当前目标 Windows 10 1809+（build 17763）及 Windows 11，x64，支持 Chrome/Edge Browser Use；不同时发布 Linux/macOS、EXE 或扩展商店版本。Store MSIX 不要求先取得独立公开 EXE 签名证书。

[1.0.4.0](validation/msix-1.0.4.0-2026-09-29.json) 与 [1.0.5.0](validation/msix-1.0.5.0-2026-09-29.json) 是历史公开验证摘要，省略发布者/包标识和产物哈希，不证明新版本。准确提交记录、身份、签名和审核访问保存在本地发布存储或 Partner Center，不提交仓库。

## 商店身份

EXE/MSI 的安装 URL 表单不能上传 MSIX。先取得 MSIX/PWA 产品；保留既有草稿/名称预留，类型或名称冲突先与 Partner Center 支持处理，不直接删除重建。

在 **Product management → Product identity** 获取值，复制 `packaging/msix/identity.example.json` 为被 Git 忽略的 `identity.local.json`，准确填写：

| JSON | Partner Center |
| --- | --- |
| `identityName` | `Package/Identity/Name` |
| `publisher` | `Package/Identity/Publisher`，含 `CN=` |
| `publisherDisplayName` | `Package/Properties/PublisherDisplayName` |
| `displayName` | 预留的展示名称 |

`version` 用四段整数，末段为 0，每次更新递增，同版本不能对应不同构建。例如源版本 `1.0.8` 对应 MSIX `1.0.8.0`，三段版本不能直接作身份版本。构建将四段版本注入关于/复制环境，Electron 元数据用对应三段 SemVer；EXE/AppImage/开发构建显示源版本。需重构包，旧包不变。

选版本前核对 Partner Center 最高已用版本（含草稿/flights），本机生成记录不能代替服务端事实。不得猜 Publisher 或从产品 ID 推导；恢复私有身份文件或从商店复制。该机器文件不入 Git。

## Windows 构建

```powershell
npm run package:msix -- --check
npm run package:msix
```

先校验身份、内置工具，再构建原生宿主与应用、由现有图标生成 Store logos，并打包 x64 full-trust 桌面程序。使用 electron-builder 26 AppX target 与 Microsoft MakeAppx **直接输出 `.msix`**。完整 Windows SDK BuildTools 10.0.26100.9169 NuGet 下载到 `tmp/msix-sdk/`，验证固定 SHA-256 后解压，避免 builder SDK 的旁加载依赖问题。编译前探测 MakeAppx，仅当前进程设置 `ELECTRON_BUILDER_WINDOWS_KITS_PATH`，不需安装系统 SDK，schema/语义验证保持启用。

每次输出到 `release-msix/` 新目录，附 `SHA256SUMS.txt` 和 `msix-build-report.json`。构建不安装证书/包、不上传、不保存商店表单、不提交审核。此 Store 产物禁用本地签名，未签名包不是普通双击旁加载安装器。

无真实身份时可测试：

```powershell
npm run test:msix
npm run package:msix -- --test
```

产物隔离在 `release-msix-test/`，名为 `TEST-ONLY-*.msix`，身份故意不同，**绝不上传**。

## 提交前验证

构建器验证 manifest、身份、必需文件和校验和，用 MakeAppx 解包真实 MSIX，基于解包文件和隔离用户数据运行应用/原生宿主 smoke，并记录源修订、dirty 状态、SDK 来源及报告。解包 smoke **不等于安装验证**。按[发布门槛](CROSS_PLATFORM_RELEASE.zh-CN.md)完成 Windows MSIX 所需检查，再在独立 Windows 测试账号/VM 安装并跑 Windows App Certification Kit；签名 EXE/Linux 门槛属于其他渠道。`--stage-only` 明确保留 Runtime 验证未完成，不能据此称可提交。

必须核对：

- 包身份下启动、持久化、Runtime 子进程、终端、搜索、插件、浏览器、更新和卸载。
- 通知、任务栏身份及快捷方式（当前使用桌面 AppUserModelID）。
- 用本次打包扩展真实配对 Chrome 和 Edge；先重新加载旧的 unpacked 扩展。记录 manifest 版本，验证同时独立配对、默认选择、显式切换、会话隔离及单独撤销。连接使用鉴权 loopback WebSocket；包数据在 LocalState/browser-connector，无 Native Messaging、执行别名或虚拟化豁免。
- 核对 `preference.json/pairing.json/routes.json/bridge.json`。普通退出保留配对/路由；暂时禁用停止控制并保留配对；移除连接撤销对应凭据，移除配置撤销全部；共享本机 broker 保留无效路由，旧独立连接器则清理 routes 文件。离线/撤销不能静默切换或重放不确定操作。
- 显式禁用、撤销、App/浏览器重启、端口占用、升级及旧外部注册迁移；清理命令在退出 CardBush 后于包身份外运行。
- 正常、运行中及崩溃后系统卸载；区分包数据清理和旧安装迁移，保留用户工作区及独立安装的浏览器扩展。
- runFullTrust 审核解释用户发起的文件、终端和插件操作；该声明不授予管理员权限。
- Windows 10 build 17763+ 与 Windows 11、x64、中英文。Windows 11 历史结果不能替代 Windows 10。

记录实际 OS/浏览器版本；Chromium 116 API 声明不是最低版本实测矩阵。未验证的第二用户隔离、最低系统和 Store 签名检查需明确列出。`scripts/test-browser-use-native.mjs` 使用源码及隔离 headless Chrome/Edge，不能替代已安装 MSIX；`scripts/verify-installed-chrome.mjs` 检查已安装 preload/IPC/身份，审核指南覆盖双浏览器。

[实现与证据记录](MSIX_CONNECTOR_REMEDIATION_PLAN_2026-09-28.md)、[2026-09-29 安装验证](MSIX_INSTALLED_VALIDATION_2026-09-29.md)属于历史。后者为 1.0.4.0/扩展 1.1.0 的特定哈希，记录迁移、卸载、WACK 警告与账号限制，不能改名当新包验证。WACK 警告/可选失败与必需失败分开报告。1.0.5.0 摘要含 Chrome/Edge、三种系统卸载和完整 WACK，同时注明管理员/UAC 关闭环境，不能替代标准用户、最低版本及 Store 签名/保护开启验证。

## 交接发布者

准备最终未签名 MSIX、校验和、构建/Runtime、安装验证和原始 WACK 报告；附[认证备注](../packaging/msix/notes-for-certification.en.txt)、[八项审核回复](../packaging/msix/store-submission.zh-CN.md)、[审核指南](../packaging/msix/reviewer-guide.en.md)。不上传测试身份、测试签名副本、证书、浏览器配置或凭据。

发布者核对身份/版本、商店介绍/隐私、受限能力理由、审核访问和包解析要求后手动提交。源码准备不自动上传、提交、发布或改商店草稿。认证签名后需从 Store 安装，并在 Windows 保护开启时验证；这与本地提交前测试不同，不能提前声称完成。隐私说明按实际 MSIX 数据保留行为核对，不能照抄 NSIS“卸载保留用户数据”。

官方参考：

- [应用身份](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)
- [MakeAppx](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [固定 SDK 包](https://www.nuget.org/packages/Microsoft.Windows.SDK.BuildTools/10.0.26100.9169)
- [上传 MSIX](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages)
- [虚拟化](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)
- [执行别名](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap5-appexecutionalias)
