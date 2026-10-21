# 独立 Agent：服务模式与可选桌面

默认是纯 Node 服务，不主动启动内置桌面或浏览器。插件可以通过自己的 MCP 连接提供桌面和浏览器能力；是否可用由实际连接和观测决定。

## 默认服务

Windows 独立服务使用 `npm run package:agent -- --out <新的输出目录>` 收集部署文件。
它复用 `build:agent` 的 Runtime 原生组件构建，并在收集前、收集后检查完整性。
部署整个输出目录，在目标目录执行 `npm ci --omit=dev --ignore-scripts`，再启动 Agent。
Windows 包必须包含 `dist-native/process-guard/current.json` 及其指定的版本化 EXE；
不能只复制 `dist-electron`、`packages` 和 `assets`。可用
`npm run verify:agent-package -- <部署目录>` 检查已收集的目录。

Agent 在接收任务前检查进程保护组件是否存在、能否启动及协议版本，组件缺失或不兼容时拒绝启动执行服务。
修复应补齐匹配当前代码的可信组件，不能关闭资源保护。仅显式 `--disable-tools` 的纯对话服务无需该组件。
更新前检查没有正在运行或排队的任务，保留独立数据目录和上一版程序；替换完整程序后重启服务。
Linux 服务不要求 Windows EXE，继续使用原有部署方式。

独立服务从当前程序包的 `assets/plugins`、`assets/skills` 加载内置内容，数据目录只保存用户安装和配置。
启动与打包会校验内置插件目录和市场清单，避免程序包里有插件、服务却查询空目录。
同时校验并登记程序包自己的 Computer Use 与 Browser Use MCP 入口；服务模式不再移除这些入口。
连接配置固定在该 Agent 数据目录，绝不复用接入端的浏览器桥或令牌。工具登记不等于桌面已可操作：
浏览器桥未连接、Windows 服务账户无法访问交互桌面时，由实际工具返回具体问题；无需预先禁用整项插件。
插件同步排除 `.gpu-cache` 等本机生成缓存；真实模型与其他资源仍遵守单文件及总包大小限制。

服务会以自身账户探测桌面条件，`desktop.status` 返回可重新探测的环境检查、缺项及修复建议。
Windows 检查交互会话与输入桌面访问权限；Linux 检查显示连接、工具、Python 模块与 Chromium。
缺少显示服务可安装并配置 Xvfb；已有可访问显示时不要求 Xvfb。未启用、依赖缺失或探测失败不表示永久无桌面能力。
`capabilities.desktop/computerUse/browserUi` 表示宿主内置控制后端是否已接通，不用于禁用独立 MCP 插件。探测不启动桌面、不采集画面、不注入输入。

Browser Use 的普通连接模式复用桌面版连接器。启用 `chrome` 内置插件后，Agent 在配置刷新前启动自己的连接器，生成 `<data-dir>/browser-connector/bridge.json`；停用插件或切换远程调试模式时停止监听，保留已有配对。Windows 安装包必须包括 `dist-native/chrome-connector/CardBushBrowserHost.exe`，用于验证连接目录和命名管道的账户权限；不按 Windows 版本或桌面探测结果禁止连接器。

在 Agent 主机上的 Chrome/Edge 安装随包提供的 `assets/plugins/chrome/extension`。通过已认证 Agent API `browser.connector` 查询 `action: "status"`，或以 `action: "pair", browser: "edge"`（也支持 `"chrome"`）生成短期配对码，在扩展弹窗中完成配对。配对码是凭据，不写入日志或公开文档。`select-default` 和 `revoke` 以连接 `id` 管理默认连接或撤销。普通服务重启会恢复已配对浏览器，浏览器资料留在其交互用户账户下；不会读取或复制客户端的浏览器登录数据。MCP 的 `list_browsers` 仍用于发现实际在线浏览器，配对不授予访问个人标签页的权限。

Windows 服务通常位于 Session 0，不能用其显示器枚举结果证明能访问登录用户桌面。需要 Computer Use 时，部署包提供独立的交互会话助手；主 Agent 保留原服务账号，助手用指定用户的普通交互令牌运行。该方式遵循 [Windows 服务与交互用户分离](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services) 的部署方式。

在目标 Windows 主机上，以管理员身份运行安装脚本（示例路径和账号需对应实际部署）：

```powershell
& .\deploy\agent\install-windows-desktop.ps1 -ReleaseRoot C:\cardbush\current -DataRoot C:\cardbush\data\agent-a -User 'HOST\desktop-user' -ServiceAccount 'HOST\cardbush-agent'
```

Node 不在安装终端的 PATH 中时，追加 `-NodePath 'C:\Program Files\nodejs\node.exe'`。助手按系统目录定位 Windows PowerShell，只补齐自身进程的 PATH，不修改整机环境变量。

安装后，在没有运行中任务时重启 Agent 服务。助手作为登录计划任务运行，不存储登录密码、不提升主服务权限；原 `computer_use` 通过标准 MCP 和带令牌的回环 HTTP 接入，原权限、观察校验及用户停止机制继续生效。助手及其子进程使用原生资源保护。只向助手提供 Computer Use 设置，不共享模型配置或 Agent 访问令牌。`desktop.status` 会检查助手所在会话；这不启用 Linux 后端的内置桌面预览面板。

用户未登录、锁屏或助手退出时应恢复指定用户的桌面/助手；已配置桥接时不会回退到 Session 0，也不会连接客户端电脑。升级保留 `desktop-bridge/connection.json` 和计划任务，更新完整 release 后重启助手与空闲的 Agent 服务。配置同步会更新单独投影的 Computer Use 设置，无需重装插件。
内置可视化桌面后端目前为 Linux；Windows 插件按其自身协议运行。服务账户与登录桌面可能属于不同会话，应依据插件返回的访问或连接错误处理，不能由服务模式推断整台主机没有桌面。

配置同步在运行时接收校验通过的配置后提交；可选 MCP 在后台连接，逐项状态继续由 MCP 设置展示，慢启动不会回滚整套模型和插件配置。必需组件、活动调用及配置本身的校验仍保留事务保护。

在仓库根目录执行：

```sh
docker compose -f deploy/agent/compose.yaml up --build -d
```

## 可选 Personal Agent 桌面

仅在需要可视化操作的独立 Personal Agent 上使用覆盖配置：

```sh
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml up --build -d
```

这会为同一个服务选择桌面镜像并显式传入 `--desktop`，包含 Xvfb、Openbox、可见 Chromium、Computer Use 和 Browser Use。没有此参数不会启动这套内置后端，已配置的独立 MCP 不受影响。桌面初始化失败时启动失败，不切到客户端电脑或偷偷禁用浏览器沙盒。

Docker 需要支持用户命名空间、Buildx 和 Compose v2；Chromium 使用普通用户和 sandbox。seccomp 配置基于 [Playwright v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json)，另外允许 Chromium 在其用户命名空间内使用 `chroot`，以兼容 `cap_drop: ALL`；没有给容器增加 capability。[Chromium 沙盒实现](https://chromium.googlesource.com/chromium/src/sandbox/+/refs/heads/main/linux/services/credentials.cc)使用这个调用，Docker 的原配置会按容器 capability 筛选规则。参见 [Docker 说明](https://docs.docker.com/engine/containers/run/)和 [Playwright 容器说明](https://playwright.dev/python/docs/docker)。不要用 privileged、host IPC、Docker socket、宿主 X socket 或 `--no-sandbox` 解决启动失败。主机禁用用户命名空间时应调整该独立部署的运行条件，不能绕过限制。

两个配置默认都只映射宿主回环地址 4780，通过 CardBush 的 HTTPS/SSH Agent 连接访问。服务首次启动在独立卷内生成 `/data/access-token`；按现有 Agent 接入流程安全取得令牌，不把令牌写到仓库、日志或截图。所有桌面操作复用已有 Agent API 鉴权；没有公开 VNC/CDP/X11 端口。

卷名由 Compose 项目确定。不同 Agent 用不同 `--project-name`，不要共享数据卷。首次创建时确认卷的 UID 与所选镜像用户匹配；两个镜像都使用 UID 1100。升级保留卷，不执行 `down -v`。浏览器配置位于 `/data/desktop/browser`，包含登录数据，应按凭据保护备份；不会从客户端复制浏览器登录状态。

## 使用与边界

- 成功启用后，CardBush Agent 会话标题栏出现“查看电脑”，在现有右侧面板显示 Linux 桌面。默认服务没有该入口。
- 首版通过已鉴权 RPC 按需获取 JPEG 画面（约每 700ms 一帧，取决于网络/操作耗时），适合桌面与网页操作，不是音视频流或低延迟远程游戏协议。预览隐藏时停止取帧。分辨率由 `CARDBUSH_DESKTOP_SIZE` 配置，默认 1600×900。
- “接管”获取服务端独占控制权，Computer Use 与 Browser Use 共用仲裁。只有持有租约的窗口可输入；租约 20 秒未续期自动失效，关闭预览主动释放。已派发操作完成后才确认接管，排队操作不会越过接管。接管失败/断线时不能宣称获得控制。
- 点击、拖动、滚动和快捷键作用于同一远程桌面，输入栏支持中文等 Unicode。图片按原尺寸映射坐标，留白不可点击；旧尺寸与过期画面拒绝输入。
- `linux_computer_use` 用原始截图坐标操作；`linux_browser_use` 提供同一可见浏览器的标签页、页面文本、元素索引、截图、输入与导航。DOM 首版覆盖顶层文档可见控件，iframe/canvas 使用 Computer Use。
- 需要模型读取截图时，当前对话需开启已有的视觉输入选项。桌面部署不会覆盖用户关闭视觉的设置；关闭时仍可预览桌面和使用 DOM 文本，但截图不会进入模型上下文。
- 模型观察绑定会话和 turn，操作后必须重新观察；另一会话或用户操作会使旧状态失效。Computer Use 还会检查截图是否变化，动态页面可能需要重新观察。终端完整访问不属于强制桌面隔离边界，不能授予不受信任的 Agent 任意终端权限后依赖接管锁限制它。
- 关闭面板、断开客户端、停止 turn 均不关闭浏览器。停止容器时才关闭桌面和浏览器；保留卷会保留浏览器配置，但不承诺恢复所有临时网页状态。超时且执行结果不明时停止继续控制，不自动重放点击。
- 桌面是每个 Personal Agent 共享的一台电脑，不是每个会话独立桌面。需要不同用户/账户隔离时部署不同容器和卷。

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

真实客户端检查使用 `scripts/run-agents-ui-test.mjs --desktop-live`：将测试实例经 SSH 转发到本机回环地址，设置 `CARDBUSH_TEST_DESKTOP_URL` 和 `CARDBUSH_TEST_DESKTOP_TOKEN_FILE`。令牌只在测试主进程读取，不注入渲染器。可在测试容器中单独启动 `node scripts/agent-desktop/ui-fixture.mjs`，打开容器内 `http://127.0.0.1:7890/`，验证页面实际收到中文输入；该测试网页不随正常服务启动。

验证记录（2026-10-03）：Ubuntu 24.04 x64、约 2 GB 内存的独立服务器完成了真实 Docker 构建和运行。默认服务没有图形进程，桌面能力关闭；可选镜像以 UID 1100、零有效/边界 capabilities、no-new-privileges、seccomp 和 docker-default AppArmor 运行，Chromium 沙盒开启。真实 DOM、X11 中文输入、1600×900 截图、越界拒绝、用户独占接管、跨会话旧观察拒绝、worker 重启保留浏览器配置，以及 HTTP Bearer/Origin 检查通过。重建容器后实例 ID、访问令牌与浏览器 localStorage 保留。真实 Agent 循环通过私有桥调用两个 Linux 工具，截图进入本地确定性模型的请求。Windows Electron 的实际组件经 SSH 隧道加载真实 Linux 画面，完成点击、中文输入、关闭面板释放控制且保持浏览器运行。全程使用临时测试网页和数据，没有调用真实模型或验证第三方网站登录策略。这是功能验收，不代表多任务压力测试。
