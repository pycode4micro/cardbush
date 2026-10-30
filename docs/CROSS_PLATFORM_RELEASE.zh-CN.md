# 平台边界与发布

[English](CROSS_PLATFORM_RELEASE.md) · [简体中文](CROSS_PLATFORM_RELEASE.zh-CN.md)

共享 Runtime、Product Host、桌面/服务适配和数据归属见[当前架构](ARCHITECTURE.md)。桌面安装与独立 worker 服务是不同部署目标，更新一个不会自动更新另一个。

`@cardbush/platform/contracts` 只有浏览器安全类型和纯能力判断；`@cardbush/platform` 包含 Node 文件/进程适配。Electron main 使用 CommonJS，Runtime 使用 ESM，均由同一源构建。renderer 不得导入 Node 入口。

## 新增或修改平台

- 在 `contracts.ts` 增加能力判断和默认 Shell，在 `index.ts` 解析可执行文件，测试注入 `PlatformContext`。
- 可执行路径、参数数组、工作目录分开传递，不把目录插入 Shell 命令文本。
- 显式请求不可用命令语言应失败；保存的交互终端偏好不可用时可回退宿主原生 Shell。
- `CARDBUSH_TERMINAL_SHELL` 只指定默认内嵌终端的一个已安装可执行文件，不能是一段带参数任意命令。Windows 的 PowerShell 工具命令也使用同一个覆盖项，并要求选择 `pwsh.exe`。
- Windows PowerShell 发现依次检查 PATH、MSI 标准位置和当前用户的 Store 别名。Store 别名解析到经过文件校验的实际二进制；元数据检查失败不代表可以启动未经验证的目标。不存在和检查受限分别诊断，发现过程不启动探测进程、不缓存“未安装”结果，也不修改文件权限。
- 设置 UI 由 IPC 能力驱动，不在 Linux 展示 Windows 专属原生服务。新平台需要原生二进制、打包规则和真实 runner，不能只加能力标记。

Agent loop、Provider 配置、用户路径、应用身份与偏好仍由原模块管理，重构不重命名用户目录或重置偏好。系统原生 API 留在各自适配层，无须为消除 `process.platform` 分支而隐藏真实平台差异。

## 发布门槛

Windows Store MSIX 使用 [MSIX 流程](MSIX_STORE_RELEASE.zh-CN.md)及准确包验证。下面的签名 NSIS/AppImage 属于另外渠道，不是仅准备 Windows Store 包的前置条件。

1. `npm ci`、`npm run runtime-tools:install`、`npm run build` 和类型检查。
2. `npm run test:release`：Runtime、权限、取消、畸形 Provider 事件、请求大小恢复、进程归属、文件边界、插件/MCP、平台契约及 Electron UI。
3. Windows x64 构建签名 NSIS，Linux x64 构建 AppImage。Windows tag 构建使用 `electron-builder.release.yml`，必须有发布者证书并审计安装器和 EXE/DLL/Node。缺签名即发布失败，不能回退开发包冒充。
4. 用隔离用户数据、无 Provider 凭据启动打包产物，检查 renderer、Runtime/Product Host IPC、Unicode 终端、内置搜索和清理退出。
5. 隔离 Windows CI 配置下安装到含空格目录、启动已安装程序并卸载，不操作用户日常安装。
6. 在 Xvfb 下启动真实 AppImage（可解包回退）；生产和发布启动器都不能禁用 Chromium sandbox。
7. 生成 SHA-256，只发布已验证提交对应产物。

工作流为 `.github/workflows/desktop.yml`。模拟 Provider 经过真实 HTTP，提供无需费用/凭据的确定性异常测试；仅对无法模拟的 Provider 专有行为补真实调用。

## 准备和发布版本

1. 从已审查目标提交开始，保留无关改动。使用 `npm version VERSION --no-git-tag-version --ignore-scripts` 同步根 `package.json` 与 lock 两处根版本。Workspace 包版本独立，不批量升级。
2. 更新双语 README、安装文件名/链接及 `docs/releases/VERSION.md`，记录相对上一公开 tag 的改动和升级要求。行为变化同步当前架构、服务、权限和插件文档，历史版本说明保留。
3. Actions 仓库 secrets 配置 `WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD`；证书、密码不进入源码、命令、日志或版本说明。工作流没指定 GitHub Environment，仅配置 environment secrets 不够。
4. 跑相关本地检查及 `npm run test:release-cleanup`，审查最终 diff，提交准备改动并推送注释 tag `vVERSION`，必须与根版本一致。
5. 等待 **Desktop builds** 两个平台构建和 publish 均通过。main 绿灯仅产生 Actions 产物（含未签名 Windows 开发包），不会发布/更新公开 Release。publish 仅在 `v*` tag 运行，核对版本和两平台校验和，先上传草稿再发布。普通版本为正式 release，仅带预发布后缀才标 prerelease。
6. 核对公开 tag、两种带版本安装器、平台校验和和启动报告，确认后才报告已发布。失败时保留旧公开版，说明失败门槛，不替换为未经验证文件。

公开 release 在该工作流中不可变，发布步骤拒绝替换文件；修复需新版本/tag。MSIX 配置可入 Git，生成包不能入 Git。npm 独立服务/CLI 发布见 [npm 文档](NPM_AGENT.md)。

## 原生资产与许可

ripgrep 清单固定各目标压缩包与可执行文件 SHA-256；安装器只从已验证归档读取预期普通文件并保留许可。跨目标检查验证字节，不执行其他平台二进制。

Windows 进程及 Browser Use ACL/包身份助手仅进入 Windows 包。Linux 目前不提供等同 Windows 的 CPU/内存强制限制、电脑操控或外部浏览器连接器；核心终端、搜索和内置浏览器不依赖它们。

原创代码采用 Apache-2.0；更新资产不得替换第三方许可，保留 Electron/Chromium 和依赖声明。
