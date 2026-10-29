# Windows 兼容性

[English](WINDOWS_COMPATIBILITY.md) · [简体中文](WINDOWS_COMPATIBILITY.zh-CN.md)

当前源码构建面向 **Windows 10 1809（build 17763）及以上 x64**，包括 LTSC 2019/2021、Windows 10 22H2 和 Windows 11。这是桌面和 MSIX 的统一基线；Microsoft Store 已发布包在新包认证上架前仍按其自己的要求。

`@cardbush/platform` 的 `minimumWindowsVersion` 与 `windowsReleaseSupported` 定义运行策略，桌面启动和 Browser Use 共同使用，回归也核对 MSIX 清单最低版本。不能由内核主版本 10 推断 Windows 11，也不能用 build 22000 限制浏览器功能：Windows 10 和 11 都报告内核主版本 10。

Windows 10 使用普通不透明背景。Mica 仅在 Windows 11 build 22621+、合成器可用且无障碍／主题设置兼容时开启。外观回退不关闭应用能力。两种系统都保留 Browser Use 的连接审批、页面授权与会话隔离。MSIX 保持正常包虚拟化，不为 Windows 10 添加注册表豁免或受限能力。

桌面发行包含 Electron/Node 与原生辅助程序。终端需要 PowerShell 7，Git 仓库操作需要 Git for Windows。内置插件集合包含其 Python/Node 运行时与媒体依赖。业务账号、NAS 权限及可选硬件驱动仍须单独配置；兼容性改动不复制凭据或改变插件业务权限。

## 验证

运行 `npm run test:windows-compatibility`、`npm run test:ui-localization`、`npm run test:app-views`、设置／浏览器连接回归、类型检查和生产构建。版本矩阵覆盖 1809 边界、LTSC 2021、22H2、Windows 11、格式错误及更旧版本拒绝。语言测试检查操作时切换语言；外观测试检查 Windows 10 无 Mica 时的深浅主题。

在 Windows 10/11 上，使用源码目录外的打包程序与隔离用户配置，检查界面／Runtime 启动、终端、搜索、插件发现、资源与正常退出。全新安装的插件 EXE 应使用仅系统 PATH 和隔离配置，测试随包媒体运行时而不下载模型或付费调用。通过一个 Windows 10 版本不代表覆盖全部 LTSC 补丁、GPU／驱动、账号配置或商店安装场景。

[2026-10-28 验证记录](validation/windows-compatibility-2026-10-28.json)保留已测 LTSC 2021 与 Windows 11 构建。商店安装、1809／LTSC 2019 和 22H2 实机覆盖不包含在这些结果中。
