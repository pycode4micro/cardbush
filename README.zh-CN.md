<p align="center">
  <img src="docs/assets/readme-hero.svg" width="100%" alt="CardBush — 你的工作区，你的 Agent。从桌面到云端，用对话完成工作。" />
</p>

<p align="center"><a href="https://apps.microsoft.com/detail/9N7XNDD5WRGS">Microsoft Store</a> · <a href="https://www.npmjs.com/package/cardbush">npm：Agent + CLI</a> · <a href="https://github.com/pycode4micro/cardbush/releases">桌面发行版</a></p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong> · <a href="docs/README.zh-CN.md">文档导航</a> · <a href="SECURITY.zh-CN.md">安全说明</a></p>

# CardBush

**让对话变成行动的个人 AI 工作区。** 使用你选择的模型处理文件、制作文档、操作浏览器、布置持续使用的画板，在本机或自己的 Agent 服务上执行任务。

桌面应用提供可视化工作空间；通过 npm 安装 Agent 和 CLI，则可以直接在终端工作。API Key 模型可独立于桌面应用运行。这些入口复用同一个 Runtime，以及工具、插件、技能和权限能力。

## 主要功能

| 能力 | 可以做什么 |
| --- | --- |
| 对话与文件 | 流式回复、添加文件与图片、查看工具执行、恢复会话，在长对话中继续工作。 |
| 创作画板 | 组合 Markdown、HTML、Office 文档、PDF、图片和音视频。更新内容时保留布局，固定某一版本，选中区域继续讨论。 |
| Team 与子 Agent | 向具名 Agent 分工，组织带依赖关系的可复用任务，沿用已有子 Agent 执行与权限体系。 |
| 浏览器与工具 | 操作内置标签页或已授权的 Chrome / Edge；通过 MCP 插件与技能扩展能力。 |
| 语音与个人助手 | 将语音转写进草稿，长按主操作按钮开始通话，或通过持续会话的助手派发任务。语音服务与可选本地语音模型分别配置。 |
| 本地与远端 | 使用本机 CLI、部署 worker 服务、连接 SSH 工作区，或为 worker 增加可选 Linux 桌面。 |

## 下载与安装

| 入口 | 获取方式 | 要求 |
| --- | --- | --- |
| Windows 桌面应用 | [Microsoft Store](https://apps.microsoft.com/detail/9N7XNDD5WRGS) | 以商店当前上架包的系统要求为准。 |
| Agent + CLI | [npm 包](https://www.npmjs.com/package/cardbush) | Node.js 24、npm 10 或更高版本；支持 Windows 与 Linux。API Key 模型不需要 Electron。 |
| 桌面安装包 | [GitHub Releases](https://github.com/pycode4micro/cardbush/releases) | 选择发行页实际附带、与系统和架构匹配的产物。 |
| 当前源码 | [开发指南](CONTRIBUTING.zh-CN.md) | 在目标操作系统上构建。 |

这些渠道分别发布。截至 2026 年 10 月 28 日，npm 已提供 **1.0.13**，GitHub 上的公开桌面产物仍为 **1.0.0-beta.3** 预发布版本。仓库中存在某个版本的说明，不代表相应安装包已经发布。商店当前可用版本以商店页面为准。

当前桌面源码支持 **Windows 10 1809+ / Windows 11 x64** 和 **Linux x64**；兼容更新上架前，商店包可能仍有不同的最低系统要求。目前没有发布 macOS、ARM64 或 32 位桌面包。详见[安装与平台支持](docs/INSTALLATION.zh-CN.md)。

### 从终端开始

```sh
npm install -g cardbush@latest
cd /path/to/your/workspace
cardbush
```

本机模式不需要连接令牌。尚未配置模型时，CLI 会展示配置文件路径与示例；编辑、保存后按 Enter 继续。本机 CLI 与应用共享受支持的模型、插件和网络设置。ChatGPT 账号模型复用应用的授权桥，因此使用这类模型时需要保持应用运行。

```sh
cardbush --resume           # 从已有会话中选择
cardbush --resume SESSION   # 继续指定会话
cardbush --help
```

执行过程中，**Enter** 将消息加入下一轮队列，**Ctrl+Enter** 立即发送指导。终端无法区分 Ctrl+Enter 时，使用 `/steer 文本`。`/artifact` 打开生成文件，`/tools` 查看执行详情，`/session` 切换会话。详见 [CLI 使用指南](docs/CLI.zh-CN.md)。

### 从桌面应用开始

1. 安装并启动 CardBush。
2. 打开 **设置 → 模型管理**，添加 API Key 模型或授权受支持的本机账号，选择与服务商匹配的 API 协议。
3. 新建会话，按需选择工作文件夹，描述任务；允许操作前查看申请的权限。
4. 进入 **创作** 在画板中组织文件，进入 **Team** 管理可复用的员工与流程，或打开侧栏助手进行持续交流。

麦克风常驻在主操作按钮旁：单击开始转写，再次单击后将识别结果插入草稿，不自动发送。长按主操作按钮开始通话，使用其停止按钮挂断。详见[语音配置](docs/REALTIME_VOICE.md)。

### 部署自己的 Agent

npm 安装同时提供 `cardbush` 与 `cardbush-agent`：

```sh
cardbush serve --background
cardbush serve --status
cardbush serve --stop
```

服务默认目录为 `~/.cardbush/service`。需要指定目录或使用进程管理器时，运行 `cardbush serve --data-dir /absolute/path/agent-data`。服务拥有自己的模型、凭据和会话。详见 [Agent 部署](docs/AGENT_SERVICES.md)和 [Docker 部署](deploy/agent/README.md)。

**当前源码预览：**远程服务通过 Team 或 `cardbush worker` 注册为子 Agent，不再打开独立 Agents 会话。两端都需从更新后的源码重新构建。这次迁移与实验性的 [subagent-remote-proton 协议](docs/SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)尚未包含在已发布的 npm 1.0.13 中。本机 CLI 仍可对话，包括在服务器上使用 CLI。

## 文档导航

[完整文档索引](docs/README.zh-CN.md)列出当前指南对应的中英文版本。历史排查与 benchmark 报告保留为带日期的记录。

| 主题 | 文档 |
| --- | --- |
| 安装、更新与排错 | [安装](docs/INSTALLATION.zh-CN.md) · [CLI](docs/CLI.zh-CN.md) · [npm 分发](docs/NPM_AGENT.md) |
| 模型与账号 | [模型接入](docs/MODEL_CONNECTIONS.md) · [ChatGPT / SIWC](docs/SIWC_INTEGRATION.zh-CN.md) |
| 创作与文档 | [画板](docs/creation-canvas.md) · [持续桌面](docs/CREATION_DESK.md) · [文档插件](docs/DOCUMENT_PLUGINS.md) |
| Team 与助手 | [Team 工作流](docs/TEAM_NATIVE_WORKFLOWS.md) · [个人助手](docs/PERSONAL_ASSISTANT.md) |
| 浏览器、语音与自动化 | [Browser / Computer Use](docs/CORE_BROWSER_COMPUTER_USE.md) · [语音](docs/REALTIME_VOICE.md) · [自动化](docs/AUTOMATIONS.md) |
| 远程工作 | [Agent 服务](docs/AGENT_SERVICES.md) · [SSH 工作区](docs/SSH_WORKSPACES.md) |
| 开发与发布 | [参与开发](CONTRIBUTING.zh-CN.md) · [架构](docs/ARCHITECTURE.md) · [发布渠道](docs/CROSS_PLATFORM_RELEASE.zh-CN.md) |

漏洞报告、数据处理与执行边界单独放在 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。普通问题与功能建议请使用 [GitHub Issues](https://github.com/pycode4micro/cardbush/issues)。

## 许可

CardBush 原创代码采用 [Apache License 2.0](LICENSE)。第三方声明与范围见 [NOTICE](NOTICE) 和[内置许可说明](docs/BUNDLED_SKILL_LICENSES.md)。依赖与外部插件保留各自的许可。
