# 独立 worker：服务部署与可选桌面

[English](README.en.md) · [简体中文](README.md)

默认是纯 Node 服务，不主动启动内置桌面或浏览器。插件可以通过自己的 MCP 连接提供桌面和浏览器能力；是否可用由实际连接和观测决定。

## 默认服务

### 本机 CLI 与远程 worker

当前源码已取消 App Agents 独立对话和 CLI 远程聊天；已发布 npm 包可能早于此迁移，使用新协议需更新两端。服务与 CLI 由同一 npm 包交付，部署会同时提供 `cardbush` 和 `cardbush-agent`，不需要桌面 App。源码目录可在构建后 `npm link --ignore-scripts` 注册命令；Docker 镜像也包含两入口。

```sh
npm install -g cardbush
cd /path/to/project
cardbush
cardbush --full-access
cardbush --resume
cardbush --resume SESSION_ID
```

本地 CLI 不需 HTTP 服务或 token，经私有 IPC 共用本机 Runtime，在 `~/.cardbush/cli-agent` 保存自己的会话，独立于 HTTP 服务。共享当前用户的 App 模型/插件/MCP/网络/沙箱配置，但不共享桌面会话数据库。服务端运行 CLI 也属于该服务器的本机执行，不附着 HTTP 实例数据库。

CLI 的命令、引导、模型配置、Ctrl+Enter 插入引导、队列、恢复、`/session`、`/tools`、`/artifact`、文件引用、本机 Shell、习惯开关、日志及退出码统一维护在[CLI 使用指南](../../docs/CLI.zh-CN.md)，不在部署指南重复另一套说明。API key 模型无需 App；ChatGPT 账号模型仍需本地桌面授权桥，不能把本机 OAuth 注册复制给远程服务。

远程实例在本地 App 的 Team 员工中注册，或：

```sh
cardbush worker add --name Worker-A --url https://agent.example.com --token-file /private/access-token
cardbush worker verify CONNECTION_ID
cardbush worker list
```

再让本地 Agent 将已验证连接/实例绑定到子 Agent 角色。连接不复制模型密钥、插件配置、主会话历史或个人文件。`--url/--token-file` 仅用于 worker 注册，不再是聊天选项。服务按自己的默认模型/工作区、权限上限执行；详见[服务架构](../../docs/AGENT_SERVICES.md)及[交互协议](../../docs/SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)。当前令牌仍为受信任宿主保存的管理凭据，不是可发给任意第三方的受限委派 token。

### 部署与检查

Agent 核心和 CLI 使用同一个 npm 包，无需 GUI：

```sh
npm install -g cardbush
cardbush serve --background
cardbush serve --status
cardbush serve --stop
```

后台直接运行 Node，不弹 PowerShell 窗口；默认使用当前用户的 `~/.cardbush/service` 和 `127.0.0.1:4780`。`--status` 给出连接令牌、模型配置和日志路径。已有实例通过 `--data-dir` 指定原目录，保留身份与历史。后台启动不自动注册系统服务或开机启动；外部服务管理器继续托管同一个前台 `cardbush serve` 命令。

Windows 终端工具要求 PowerShell 7（pwsh），不回退 Windows PowerShell 5；已支持 AppContainer 沙箱及原生资源保护。Linux 已有 bubblewrap 沙箱，但需主机安装及允许用户命名空间，尚无额外 seccomp 过滤或 Windows Job Object 同等的内核资源限额。两端沙箱失败都不回退宿主执行。详细部署步骤、平台限制、模型配置、连接与更新方法统一维护在 [cardbush-docs 的部署说明](../../assets/skills/cardbush-docs/references/agent-deployment.md)。

部署由 Agent 或用户执行，核心不管理系统账户、计划任务或插件依赖。第三方插件按其自己的安装说明另行处理。既有 Computer Use 桌面桥和可选 Personal Agent 桌面保留原实现，不属于默认核心部署步骤。

源码构建完整核心目录包使用 `npm run package:agent -- --out <新目录>`；包内含服务、CLI、必要资源与部署 Skill。`DEPLOY.txt` 提供入口，实际安装通过发布版本或目标平台依赖安装完成。

## 可选 worker 桌面

仅在需要可视化操作的独立 worker 上使用覆盖配置：

```sh
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml up --build -d
```

这会为同一个服务选择桌面镜像并显式传入 `--desktop`，包含 Xvfb、Openbox、可见 Chromium、Computer Use 和 Browser Use。没有此参数不会启动这套内置后端，已配置的独立 MCP 不受影响。桌面初始化失败时启动失败，不切到客户端电脑或偷偷禁用浏览器沙盒。

Docker 需要支持用户命名空间、Buildx 和 Compose v2；Chromium 使用普通用户和 sandbox。seccomp 配置基于 [Playwright v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json)，另外允许 Chromium 在其用户命名空间内使用 `chroot`，以兼容 `cap_drop: ALL`；没有给容器增加 capability。[Chromium 沙盒实现](https://chromium.googlesource.com/chromium/src/sandbox/+/refs/heads/main/linux/services/credentials.cc)使用这个调用，Docker 的原配置会按容器 capability 筛选规则。参见 [Docker 说明](https://docs.docker.com/engine/containers/run/)和 [Playwright 容器说明](https://playwright.dev/python/docs/docker)。不要用 privileged、host IPC、Docker socket、宿主 X socket 或 `--no-sandbox` 解决启动失败。主机禁用用户命名空间时应调整该独立部署的运行条件，不能绕过限制。

两个配置默认都只映射宿主回环地址 4780，通过 HTTPS/SSH worker 注册访问。服务首次启动在独立卷内生成 `/data/access-token`；按现有 Agent 接入流程安全取得令牌，不把令牌写到仓库、日志或截图。所有桌面操作复用已有 Agent API 鉴权；没有公开 VNC/CDP/X11 端口。

卷名由 Compose 项目确定。不同 Agent 用不同 `--project-name`，不要共享数据卷。首次创建时确认卷的 UID 与所选镜像用户匹配；两个镜像都使用 UID 1100。升级保留卷，不执行 `down -v`。浏览器配置位于 `/data/desktop/browser`，包含登录数据，应按凭据保护备份；不会从客户端复制浏览器登录状态。

## 使用与边界

- 桌面能力由 worker 的能力快照及已鉴权管理接口提供。App 不再有独立 Agents 会话入口；当前子任务检查仍复用已有会话后端，不能把服务的桌面能力声明当作已提供新的用户接管入口。默认服务不启动桌面。
- 首版通过已鉴权 RPC 按需获取 JPEG 画面（约每 700ms 一帧，取决于网络/操作耗时），适合桌面与网页操作，不是音视频流或低延迟远程游戏协议。预览隐藏时停止取帧。分辨率由 `CARDBUSH_DESKTOP_SIZE` 配置，默认 1600×900。
- “接管”获取服务端独占控制权，Computer Use 与 Browser Use 共用仲裁。只有持有租约的窗口可输入；租约 20 秒未续期自动失效，关闭预览主动释放。已派发操作完成后才确认接管，排队操作不会越过接管。接管失败/断线时不能宣称获得控制。
- 点击、拖动、滚动和快捷键作用于同一远程桌面，输入栏支持中文等 Unicode。图片按原尺寸映射坐标，留白不可点击；旧尺寸与过期画面拒绝输入。
- `linux_computer_use` 用原始截图坐标操作；`linux_browser_use` 提供同一可见浏览器的标签页、页面文本、元素索引、截图、输入与导航。DOM 首版覆盖顶层文档可见控件，iframe/canvas 使用 Computer Use。
- 需要模型读取截图时，当前对话需开启已有的视觉输入选项。桌面部署不会覆盖用户关闭视觉的设置；关闭时仍可预览桌面和使用 DOM 文本，但截图不会进入模型上下文。
- 模型观察绑定会话和 turn，操作后必须重新观察；另一会话或用户操作会使旧状态失效。Computer Use 还会检查截图是否变化，动态页面可能需要重新观察。终端完整访问不属于强制桌面隔离边界，不能授予不受信任的 Agent 任意终端权限后依赖接管锁限制它。
- 关闭面板、断开客户端、停止 turn 均不关闭浏览器。停止容器时才关闭桌面和浏览器；保留卷会保留浏览器配置，但不承诺恢复所有临时网页状态。超时且执行结果不明时停止继续控制，不自动重放点击。
- 桌面是每个 worker 共享的一台电脑，不是每个会话独立桌面。需要不同用户/账户隔离时部署不同容器和卷。

## 验证

插件同步只更新所选插件文件和启用状态，保留 Agent 已有的插件参数与独立 MCP 配置，不采集发送端环境变量或用户保存的插件配置。宿主不推断解释器、不下载安装依赖、不改写启动命令；插件自带的启动脚本仍按其声明运行，配置提交和工具可用分别验证。

打包时把依赖声明、配置名称和验证方式写进插件 Skill 或其引用文档；接收端 Agent 在使用或修复插件时根据实际主机、账号和用途处理。复用 [CardBush 插件管理 Skill](../../assets/skills/cardbush-docs/references/plugin-management.md)，不增加环境同步选项、固定安装流程或自动模型任务。

Windows 可运行 `npm run test:agent-desktop` 检查协议、控制权、坐标及默认关闭行为；此检查不等于真实 Linux 验证。

在可用 Linux Docker 主机运行：

```sh
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml build
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml run --rm --no-deps --entrypoint /bin/bash agent -lc 'Xvfb :99 -screen 0 1600x900x24 -nolisten tcp & sleep 1; openbox & /opt/desktop-venv/bin/python3 scripts/agent-desktop/smoke.py'

# 使用独立临时数据验证真实 Python worker、控制仲裁和 Agent HTTP。
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml run --rm --no-deps --entrypoint /bin/bash agent -lc 'Xvfb :99 -screen 0 1600x900x24 -nolisten tcp & sleep 1; openbox & node scripts/test-agent-desktop-live.mjs'
```

该检查使用临时浏览器配置和本机测试网页，不调用模型、不读取真实账号。还需通过桌面客户端验证预览、接管/交还、关闭预览保持页面、容器重启保留登录配置，以及普通镜像不启动 X/浏览器。不要把单元测试或构建成功记作这些实机验收已通过。

旧版独立 Agents UI 的历史客户端检查使用 `scripts/run-agents-ui-test.mjs --desktop-live`（当前该脚本已改为 worker 注册界面回归，不再代表这条历史流程）：将测试实例经 SSH 转发到本机回环地址，设置 `CARDBUSH_TEST_DESKTOP_URL` 和 `CARDBUSH_TEST_DESKTOP_TOKEN_FILE`。令牌只在测试主进程读取，不注入渲染器。可在测试容器中单独启动 `node scripts/agent-desktop/ui-fixture.mjs`，打开容器内 `http://127.0.0.1:7890/`，验证页面实际收到中文输入；该测试网页不随正常服务启动。

验证记录（2026-10-03）：Ubuntu 24.04 x64、约 2 GB 内存的独立服务器完成了真实 Docker 构建和运行。默认服务没有图形进程，桌面能力关闭；可选镜像以 UID 1100、零有效/边界 capabilities、no-new-privileges、seccomp 和 docker-default AppArmor 运行，Chromium 沙盒开启。真实 DOM、X11 中文输入、1600×900 截图、越界拒绝、用户独占接管、跨会话旧观察拒绝、worker 重启保留浏览器配置，以及 HTTP Bearer/Origin 检查通过。重建容器后实例 ID、访问令牌与浏览器 localStorage 保留。真实 Agent 循环通过私有桥调用两个 Linux 工具，截图进入本地确定性模型的请求。Windows Electron 的实际组件经 SSH 隧道加载真实 Linux 画面，完成点击、中文输入、关闭面板释放控制且保持浏览器运行。全程使用临时测试网页和数据，没有调用真实模型或验证第三方网站登录策略。这是功能验收，不代表多任务压力测试。
