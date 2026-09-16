# CardBush

[English](README.md) · **简体中文**

面向对话、文件、编程和 MCP 插件的桌面 AI 工作区。Agent Runtime 随应用运行，核心对话与终端工具不需要额外启动本地服务器或安装 Python。

## 下载

当前版本：**1.0.0-beta.2**。按操作系统选择安装包。

| 系统 | 下载 | 适用电脑 |
| --- | --- | --- |
| Windows 10 / 11 | [Windows x64 安装程序（.exe）](https://github.com/pycode4micro/cardbush/releases/download/v1.0.0-beta.2/CardBush-1.0.0-beta.2-windows-x64.exe) | Intel / AMD 64 位 |
| Linux | [Linux x64 AppImage](https://github.com/pycode4micro/cardbush/releases/download/v1.0.0-beta.2/CardBush-1.0.0-beta.2-linux-x86_64.AppImage) | x86-64 桌面 Linux，建议 Ubuntu 22.04 或更新版本 |

[全部版本与 SHA-256 校验文件](https://github.com/pycode4micro/cardbush/releases) · [构建与验证流程](https://github.com/pycode4micro/cardbush/actions/workflows/desktop.yml)

两个平台均使用同一 Beta 2 源码标签构建。本次更新包含主题适配与交互图表、HTML 预览高度限制及展开、文件更新自动刷新、子 agent 和图像执行预览，以及引导消息与侧栏行为修复。详见[发布说明](docs/releases/1.0.0-beta.2.md)，SHA-256 校验文件随安装包提供。

Windows 10 和 11 使用同一个安装包，无需按 Intel、AMD 或显卡型号区分。本次不提供 ARM64、32 位 Windows、Windows 7/8 或 macOS 安装包。Beta 安装包尚未进行代码签名。

### 安装与开始使用

**Windows：** 打开安装程序，选择安装位置，完成后启动 CardBush。卸载应用会保留本地对话和设置。

**Linux：** 下载后赋予执行权限并启动：

```sh
chmod +x CardBush-1.0.0-beta.2-linux-x86_64.AppImage
./CardBush-1.0.0-beta.2-linux-x86_64.AppImage
```

AppImage 需要 FUSE 2（Ubuntu 22.04 可运行 `sudo apt install libfuse2`）。没有 FUSE 时可使用 `APPIMAGE_EXTRACT_AND_RUN=1` 启动。Chromium 需要正常的沙箱环境，不建议通过关闭沙箱解决安装问题。

首次启动后，在 **设置 → 模型管理** 中配置模型服务、模型名称和 API 密钥。模型费用由所选服务商计收。插件可能需要自己的依赖或凭证，请按照插件说明安装。

## 主要功能

- 流式对话、项目、文件附件和预览。
- 文件搜索与编辑、终端命令、工具权限和执行历史。
- 消息排队、引导、子 Agent、会话持久化，以及应用运行期间的自动化。
- MCP 插件、技能和内置浏览器。
- 个性化、快捷键和独立保存的使用统计。

Team 工作流作为独立插件安装，不包含在桌面安装包中，详见 [Team 插件架构](docs/TEAM_PLUGIN_EXTRACTION.md)。

### 平台能力

| 功能 | Windows x64 | Linux x64 |
| --- | --- | --- |
| 对话、文件、预览、MCP、内置浏览器 | 支持 | 支持 |
| 终端命令 | PowerShell / cmd | POSIX Shell |
| 应用内终端选择 | PowerShell，已安装的 Git Bash / WSL | 系统 Shell，已安装的 PowerShell |
| 随包文件搜索 | Windows ripgrep | Linux ripgrep |
| Windows 电脑操控插件 | 支持 | 不可用 |
| Chrome 原生连接器 | 支持 | 不可用，仍可使用内置浏览器 |
| 进程 CPU / 内存原生限制 | Windows Job Objects | 尚未实现 |
| 托管进程准入与所属进程清理 | 支持 | 支持 |

Linux 的资源隔离能力尚未与 Windows 完全一致。外部插件是独立程序，各自的平台要求仍需满足。终端设置不会把 Agent 命令自动改写成另一种 Shell 语法。

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
npm run package:win     # 在 Windows 生成 NSIS 安装程序
npm run package:linux   # 在 Linux 生成 AppImage
npm run smoke:packaged
```

无桌面的 Linux 可使用 `xvfb-run -a npm run test:release`。产物位于 `release/`。运行 `test:release` 前先构建；它覆盖包测试、对抗场景、平台约束和 Electron 界面测试，避免为每个测试重复构建。更广的功能专项检查可运行 `npm run test:all`。模型协议测试使用本地模拟 HTTP 服务，不需要真实 API 密钥。

Electron 默认从官方源下载，网络需要时可设置 `ELECTRON_MIRROR`。下载不完整时运行 `npm run fix:electron` 修复。

## 架构与维护

| 目录 | 职责 |
| --- | --- |
| `packages/cardbush-platform` | 平台能力、Shell 解析、可执行文件查找、原生资源路径 |
| `packages/bush-runtime` | 与模型厂商无关的 Agent 循环、工具、权限和状态 |
| `packages/bush-protocol` | 命令、事件与 IPC 类型约定 |
| `packages/bush-provider-openai` | OpenAI 兼容模型传输 |
| `electron` | 桌面生命周期、隔离的 Runtime 进程和原生适配 |
| `src` | React 界面与 Runtime 客户端 |
| `scripts` | 开发、回归测试、打包和启动检查 |

平台选择集中在 `@cardbush/platform`，浏览器可用的类型约定与 Node 适配分别导出。剪贴板、电脑操控和进程限制等系统专属功能保留在明确的适配模块中。新增平台不需要修改 Agent 循环。本次只完善应用内终端，没有新增独立命令行 Agent。

详见 [跨平台维护与发布指南](docs/CROSS_PLATFORM_RELEASE.md)、[应用宿主](docs/host/CARDBUSH_APP_HOST.md)和 [内置 Apps MCP](docs/host/CARDBUSH_APPS_MCP.md)。

## 数据与安全

对话、使用记录和设置保存在 Electron 的本地用户数据目录。清理临时缓存不会重置已经记录的使用量。界面启用上下文隔离，不直接访问 Node.js。模型服务和外部插件会接收完成所请求操作需要的数据。

提交公开问题时，请移除密钥、原始对话数据和日志中的敏感信息。

## 开源协议

CardBush 原创代码使用 [Apache License 2.0](LICENSE)，另见 [NOTICE](NOTICE)。随包依赖、技能及外部插件保留各自的许可证。
