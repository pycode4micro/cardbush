# CardBush

[English](README.md) · **简体中文**

面向对话、文件、编程、自动化和 MCP 插件的桌面 AI 工作区。可使用内置本地 Agent、SSH 项目，或通过 HTTPS / SSH 连接独立 Agent 服务。本地与远端对话共用界面，核心本地对话与命令工具不需要额外启动服务器或安装 Python。

## 下载

源码版本：**1.0.0-beta.4**。以下安装包在标签发布流程通过双平台验证后提供；发布完成前，请从[发行版页面](https://github.com/pycode4micro/cardbush/releases)选择最新已发布版本。

| 系统 | 下载 | 适用电脑 |
| --- | --- | --- |
| Windows 11 | [Windows x64 安装程序（.exe）](https://github.com/pycode4micro/cardbush/releases/download/v1.0.0-beta.4/CardBush-1.0.0-beta.4-windows-x64.exe) | Intel / AMD 64 位 |
| Linux | [Linux x64 AppImage](https://github.com/pycode4micro/cardbush/releases/download/v1.0.0-beta.4/CardBush-1.0.0-beta.4-linux-x86_64.AppImage) | x86-64 桌面 Linux；CI 使用 Ubuntu 22.04 验证 |

[全部版本与 SHA-256 校验文件](https://github.com/pycode4micro/cardbush/releases) · [构建与验证流程](https://github.com/pycode4micro/cardbush/actions/workflows/desktop.yml)

两个平台均使用同一 Beta 4 源码标签构建。本次加入独立 Agent 服务、SSH 工作区、应用中心、本地与远端共用的对话和设置、命令沙盒，并改善工具执行与上下文恢复。详见[发布说明](docs/releases/1.0.0-beta.4.md)。SHA-256 校验文件和成品启动报告随包提供；主分支构建成功不等于已经发布发行版。

当前 Windows 开发版本面向 Windows 11 x64（build 22000 起），包括商店 MSIX 与 Browser Use（Chrome / Edge）；历史下载版本可能有不同要求。无需按 Intel、AMD 或显卡型号区分。本次不支持 ARM64、32 位 Windows、Windows 7/8/10 或 macOS 安装包。Windows EXE 发行流程要求发布者签名证书；普通 CI 构建生成未签名的开发安装包。

商店 MSIX 使用独立的四段版本号，由 Microsoft 在认证过程中签名；不能把仅用于本机验证的测试签名副本上传商店。当前候选包与提交说明见 [MSIX 提交准备](docs/MSIX_SUBMISSION_PREPARATION_2026-09-29.md)，本仓库提供准备材料，不代表已经通过或提交认证。

### 安装与开始使用

**Windows EXE：** 打开安装程序，选择安装位置，完成后启动 CardBush。EXE 版卸载保留本地对话和设置。MSIX 由 Windows 管理包目录与应用数据，正常系统卸载会清理包所属数据；用户另外保存的工作区文件、浏览器配置和手动安装的扩展不会一并删除。

**Linux：** 下载后赋予执行权限并启动：

```sh
chmod +x CardBush-1.0.0-beta.4-linux-x86_64.AppImage
./CardBush-1.0.0-beta.4-linux-x86_64.AppImage
```

AppImage 需要 FUSE 2（Ubuntu 22.04 可运行 `sudo apt install libfuse2`）。没有 FUSE 时可使用 `APPIMAGE_EXTRACT_AND_RUN=1` 启动。Chromium 需要正常的沙箱环境，不建议通过关闭沙箱解决安装问题。

首次启动后，在 **应用中心 → 设置 → 模型管理** 中配置模型服务、模型名称和 API 密钥。设置页顶部可选择本机或已连接的 Agent。模型费用由所选服务商计收。插件可能需要自己的依赖或凭证，请按照插件说明安装。

## 主要功能

- 本地与远端共用的流式对话、项目、图片附件、预览、消息排队和运行中引导。
- 应用中心统一提供插件、定时和设置入口，支持拖拽快捷方式、应用链接、Windows 本地应用快捷方式与 `@` 应用引用。
- 文件搜索、版本校验编辑、批量加载 MCP 工具定义、归档结果检索和终端完成通知。
- **申请批准／完全访问** 两档权限，以及单独管理的 Windows / Linux 命令沙盒。
- 会话持久化、子 Agent、自动化、日历视图和可选的离线中国／美国显示日历。
- MCP 插件、技能、内置浏览器、对话提取和上下文恢复。内置技能包括 Agent 部署和 Blender 视频预演。
- 页面前进后退、跟随主题的悬浮提示与快捷键、个性化和独立保存的使用统计。

通过 **Agents → +** 接入独立服务。服务拥有自己的模型配置、凭据、项目、插件和任务队列，桌面断开后已接收的任务仍可继续。**SSH 项目**则由桌面运行 Agent，将支持的文件和命令操作交给指定 SSH 主机。详见[独立 Agent 服务](docs/AGENT_SERVICES.md)与 [SSH 工作区](docs/SSH_WORKSPACES.md)。

应用中心只显示实际可打开的页面和用户选择的应用；普通 MCP 连接仍在插件设置中管理。`@` 引用向 Agent 提供应用上下文，不代表已经执行或授予权限。详见[应用中心说明](assets/skills/cardbush-docs/references/app-center.md)。

Team 工作流作为独立插件安装，不包含在桌面安装包中，详见 [Team 插件架构](docs/TEAM_PLUGIN_EXTRACTION.md)。

### 平台能力

| 功能 | Windows x64 | Linux x64 |
| --- | --- | --- |
| 对话、文件、预览、MCP、内置浏览器 | 支持 | 支持 |
| 终端命令 | PowerShell / cmd | POSIX Shell |
| 随包文件搜索 | Windows ripgrep | Linux ripgrep |
| 命令沙盒 | AppContainer | bubblewrap，需宿主环境支持 |
| Windows 电脑操控插件 | 支持 | 不可用 |
| Browser Use（Chrome / Edge） | 支持 | 不可用，仍可使用内置浏览器 |
| 进程 CPU / 内存原生限制 | Windows Job Objects | 尚未实现 |
| 托管进程准入与所属进程清理 | 支持 | 支持 |

Linux 的 CPU／内存限制尚未与 Windows 完全一致。外部插件是独立程序，各自的平台要求仍需满足。远端服务提供自身主机的能力，不继承连接它的桌面能力。

沙盒设置先检测环境，需要安装依赖时由用户点击。已安装且可用的沙盒默认启用，用户或管理员显式关闭的设置会保留。通常的 `auto` 策略下，**申请批准**隔离命令并在需要时申请额外权限，**完全访问**使用普通进程；管理员设定的 `required` 策略在两档模式下均有效。命令沙盒不覆盖全部 MCP、插件和浏览器行为。详见[权限说明](docs/PERMISSIONS.md)及[沙盒范围与限制](docs/EXECUTION_SANDBOX.md)。

## 开发与打包

需要 Node.js **>=22.12**、npm **>=10**；CI 使用 Node.js 24。安装程序在对应操作系统上构建。

```sh
npm ci
npm run runtime-tools:install
npm run dev
```

```sh
npm run build
npm run typecheck
npm run test:release
npm run package:win     # 在 Windows 生成签名 NSIS 安装程序，需要发布者证书
npm run package:linux   # 在 Linux 生成 AppImage
npm run smoke:packaged
```

无桌面的 Linux 可使用 `xvfb-run -a npm run test:release`。产物位于 `release/`。运行 `test:release` 前先构建；它覆盖包测试、对抗场景、平台约束和 Electron 界面测试，避免为每个测试重复构建。更广的功能专项检查可运行 `npm run test:all`。模型协议测试使用本地模拟 HTTP 服务，不需要真实 API 密钥。

无图形界面的 Agent 服务使用 `npm ci --ignore-scripts`、`npm run build:agent` 构建，然后运行 `node dist-electron/agentServiceCli.mjs --data-dir /absolute/path/agent-data`。服务由 Node.js 运行，不启动 Electron。使用独立数据目录，并按[部署指南](docs/AGENT_SERVICES.md)配置鉴权及 SSH / HTTPS 接入。更新桌面安装包不会部署或更新这个服务。

Electron 默认从官方源下载，网络需要时可设置 `ELECTRON_MIRROR`。下载不完整时运行 `npm run fix:electron` 修复。

## 架构与维护

| 目录 | 职责 |
| --- | --- |
| `packages/cardbush-platform` | 平台能力、Shell 解析、可执行文件查找、原生资源路径 |
| `packages/bush-runtime` | 与模型厂商无关的 Agent 循环、工具、权限和状态 |
| `packages/bush-product-agent` | 共用的产品指令与回合请求构造 |
| `packages/cardbush-product-host` | 模型、插件、MCP、沙盒和维护的共享命令约定及配置 |
| `packages/bush-protocol` | 命令、事件与 IPC 类型约定 |
| `packages/bush-provider-openai` | OpenAI 兼容模型传输 |
| `packages/bush-mcp-client` | MCP 传输及工具／资源接入 |
| `packages/bush-runtime-electron` | 桌面与 Node 宿主共用的类型化 Runtime 传输和客户端 |
| `electron` | 桌面生命周期、Utility Runtime 宿主、无界面 Agent 服务与宿主适配 |
| `src` | 共用的 React 对话／设置界面及本地／远端适配 |
| `scripts` | 开发、回归测试、打包和启动检查 |

平台选择集中在 `@cardbush/platform`，浏览器可用的类型约定与 Node 适配分别导出。桌面在 Electron utility process 中托管 Runtime，独立服务由 Node.js 托管同一个 worker。Product Host 与后端适配决定配置和操作所属的环境，对话界面消费共用的 Runtime 事件，不再维护另一套云端消息投影。

详见[当前架构](docs/ARCHITECTURE.md)、[跨平台维护与发布指南](docs/CROSS_PLATFORM_RELEASE.md)、[工具交互约定](docs/TOOL_INTERACTION.md)和 [内置 Apps MCP](docs/host/CARDBUSH_APPS_MCP.md)。

## 数据与安全

本地对话、使用记录和设置保存在 Electron 用户数据目录。每个独立 Agent 将自身数据和凭据保存在服务器的数据目录，切换环境不会自动复制到另一台主机。本地自动化依赖桌面应用运行；独立 Agent 的队列及其支持的自动化在服务运行期间执行。清理临时缓存不会重置已经记录的使用量。

界面启用上下文隔离，不直接访问 Node.js。远端接入需鉴权，访问令牌代表整个实例的访问权限，当前不是多租户账号系统。模型服务和外部插件会接收完成所请求操作需要的数据。文件／工具权限与操作系统命令隔离属于不同控制层。

提交公开问题时，请移除密钥、原始对话数据和日志中的敏感信息。

## 开源协议

CardBush 原创代码使用 [Apache License 2.0](LICENSE)，另见 [NOTICE](NOTICE)。随包依赖、技能及外部插件保留各自的许可证。
