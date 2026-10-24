# 独立 Agent：服务模式与可选桌面

默认是纯 Node 服务，不主动启动内置桌面或浏览器。插件可以通过自己的 MCP 连接提供桌面和浏览器能力；是否可用由实际连接和观测决定。

## 默认服务

### 原生终端对话

在程序目录注册一次命令：

```sh
npm link --ignore-scripts
```

之后进入要工作的文件夹，直接启动本地 CLI，无需预先启动 HTTP 服务或提供服务令牌：

```sh
cd /path/to/project
cardbush                         # 当前目录，默认申请审批
cardbush --full-access           # 当前目录，本次启动使用完全访问
cardbush --resume <会话ID>          # 继续原会话，保留原工作区
cardbush --local                 # 已保存远程连接时，明确改用本机
```

CLI 使用 Node 自带 readline 和普通标准输入输出，保留终端滚动记录、复制和重定向，不使用全屏 TUI、浏览器或额外绘制层。新会话默认信任当前目录，复用 Agent 的项目登记和路径校验，将其作为直接工作区；不会弹出额外的目录信任确认。目录信任与工具审批分开，默认仍为申请审批，完全访问也保留宿主强制限制、沙盒策略和进程保护。本地执行使用当前系统账号；连接服务时使用服务账号。

CLI 自身的启动、帮助、补全、状态、审批操作提示和配置示例统一使用英文。模型回复及模型生成的问题继续遵循用户的语言，文件路径、插件描述和用户输入保留原文；英文 UI 只作为缺少用户语言证据时的兜底，不覆盖对话语言。

本地模式复用同一套 Agent 运行时、工具和审批，通过进程内调用工作，不监听端口，不创建访问令牌。会话数据独立保存在 `~/.cardbush/cli-agent`，不会读写桌面版的会话数据库。CLI 与 App 直接共用当前用户配置根目录下的 `product-host/config/*.json`：模型、插件、MCP、网络及沙盒设置只有一份，并使用相同的配置存储和校验。插件和 Skill 也共用该用户目录；浏览器使用已有的认证连接，不重新注册桌面浏览器连接器。没有桌面配置时，CLI 也在同一位置创建配置，之后 App 可以直接使用。

没有模型或配置文件无效时，CLI 会显示配置文件的完整路径、带字段说明的示例，并等待用户编辑保存后按回车重新读取。可在此直接输入 `vim "文件路径"` 等编辑命令，在同一个终端完成配置；退出编辑器后单独按回车才会重新加载。不打开桌面设置，不发送模型测试请求；`/quit`、`/exit` 或 Ctrl+C 可退出。Windows 默认模型配置位于 `%APPDATA%/cardbush/product-host/config/models.json`，同目录保存 `models.example.json`。示例使用合法 JSON 的 `_comment` 字段解释参数，说明字段可保留或删除，必填的 `model` 初始为空；支持多个模型与 `defaultModelId`。已有文件不会被示例覆盖，格式错误也不会回显配置中的密钥。管道模式未配置模型时显示路径并退出（退出码 2），不会等待输入或提交提示。

`CARDBUSH_CLI_DATA_DIR` 仅指定 CLI 会话、任务和日志目录，不再另选一份模型设置。旧 CLI 数据目录内的配置原样保留，但不覆盖 App 设置。`CARDBUSH_CLI_PROFILE_DIR` 可显式指定另一套 App 配置根目录（例如服务器上独立的用户配置）。默认目录为 Windows 的 `%APPDATA%/cardbush`、macOS 的 `~/Library/Application Support/cardbush`、Linux 的 `$XDG_CONFIG_HOME/cardbush`（未设置时为 `~/.config/cardbush`）。本地目录保留原有单进程锁，退出后可恢复会话；重复打开同一 CLI 数据目录会明确报错。

- 直接输入并回车开始一轮；任务运行时输入区仍可编辑，回车将消息保存到下一轮队列，`/steer 内容` 引导当前任务。任务完成后自动接续队列；未提交的草稿和光标位置保留。引导显示已排队，收到宿主实际应用事件后才显示已应用。提交回执丢失时按原请求 ID 查询，手动重试同一内容复用原请求，避免重复执行。
- `/new` 新建会话，`/quit`、`/exit` 退出并显示恢复命令，`/help` 查看选项，`/logs` 显示本地后台诊断日志位置。`/q` 不再是独立命令；交互输入 `/q` 后回车确认匹配出的 `/quit`。运行中的 `/model`、`/settings`、`/session`、`/new`、`/shell` 和 `!命令` 提示先完成或停止当前任务。
- 启动信息显示实际模型、推理强度、工作目录、权限和会话；`/model` 先选择模型，再选择 reasoning effort，`/model ID` 直接进入该模型的强度选择。方向键选择、回车确认，Tab 只补全，Esc 从强度页返回模型页、从模型页返回对话；也支持输入编号或名称，`/cancel` 放弃整次修改。选项复用 App 的协议规则，可选择 `Model setting` 跟随共享配置、`Provider default` 不指定强度，或显式选择可用等级。两步确认后才生效，不改 App 默认项；普通发送和队列消息均使用所选强度，`--resume` 和 `/session [ID]` 恢复目标会话最近一次提交的模型和强度，保留显式的 `Provider default`；空会话或原模型已不可用时使用当前默认模型及其配置强度，不沿用上一会话的选择。启动时显式 `--model ID` 优先，使用该模型自身的配置强度。`/settings` 显示共用配置的位置，文件保存后按回车重新读取模型并刷新工具配置。默认模型通过同一份 `models.json` 或 App 设置修改。
- 对话按 App 的 Runtime 消息分段追加显示，支持标题、粗体、代码块和链接；思考与正在运行的工具共用一条临时状态行，完成后留下简短工具记录。工具失败与 App 共用结构化状态判断；计时从实际执行开始，排队等待不计入执行时长。
- 终端中的回复按窗口宽度排版，宽窗口限制阅读行长；标题、段落、列表项和完成状态之间留出间距，列表续行缩进对齐，工具名称和英文单词尽量保持完整。代码块保留原有空白，超长行由终端自然折行；重定向到文件或管道时保留原始 Markdown。
- Markdown 表格按显示宽度对齐列和边框，支持单元格换行、左右/居中对齐、行内代码和转义竖线。流式输出按完整行追加，窄窗口放不下多列时按字段展开，不截掉内容；代码块中的表格示例和重定向输出保留原文。
- 用户输入使用灰色背景，提交后保留，回复使用默认背景；底部输入区最多显示光标附近 4 行，其上显示当前活动，其下显示操作或补全提示。流式回复在上方追加，仅重绘未完成的输出行和小型输入区，不清空历史或切换全屏缓冲区。设置 `NO_COLOR` 时保留无配色输出，纯文本终端继续使用顺序问答。
- 输入 `/` 即时提示内置命令与当前 Agent 的可调用技能、插件命令；完整匹配和命令名前缀优先，例如 `/e` 只匹配以 `/e` 开头的命令，无前缀匹配时才按字符顺序模糊匹配，例如 `/qt` 匹配 `/quit`。输入 `@` 浏览当前会话工作区的文件和目录，可在一句话中引用多个文件。含空格的路径使用 `@"目录/文件 名.txt"`。文件引用复用现有附件机制，不预读内容或放宽权限；目录引用保留在正文，模型按需读取。普通 Skill 按文件引用传递，插件命令保留原来的调用和审批机制。
- 候选默认选中第一项，`↑/↓` 切换候选；`Enter` 确认当前命令，`Tab` 只填入，不执行。文件或路径候选按回车先填入草稿，再次回车发送。无候选时上下键回看输入历史；会话工作区中的显式路径、模型与强度选择、确认问题也支持 Tab。空白审批仍使用原默认行为。提示只占输入框下方几行，本地候选同步更新，输入时不切回通用操作提示；远程查询按会话隔离，迟到的结果不会改写新草稿。审批答案不进入对话历史。
- `/shell vim "文件路径"` 或 `!vim "文件路径"` 在当前终端执行本机命令；输入 `/sh` 可补全 `/shell`；单独 `/shell` 打开原生 Shell，使用其命令和路径补全，输入 `exit` 返回 CLI。聊天输入框中的 Shell 参数不查询远程 Agent 文件列表，避免误填远程路径。`/settings` 和首次模型配置提示中也可直接输入 `vim "文件路径"` 等命令。复用平台 Shell 发现及 `CARDBUSH_TERMINAL_SHELL` 配置，交互程序直接接管标准输入输出；退出后恢复 CLI 草稿、光标及终端输入模式，不另开窗口。聊天中普通文本不会被猜测为系统命令，命令及输出不提交模型。连接远程 Agent 时，这个入口仍在本机执行，使用 CLI 启动目录；本地会话使用会话工作目录。原生程序使用当前系统账号；模型工具仍经过原来的审批、沙盒及资源保护。任务运行中先完成或停止任务，再使用该入口。
- 多行或超过 1000 字符的粘贴折叠为字数/行数标记，按回车后恢复完整文本作为一条消息提交，粘贴中的换行和 Tab 不会执行命令或接受候选。单次最多 1,000,000 字符，超大文本请引用文件。
- 计划更新只显示进度和当前步骤，`/plan` 查看完整计划。模型请求失败后回到输入提示，可修改设置再发送，不自动重提失败请求。管道和单轮命令仍用错误退出码报告失败。
- `--sessions` 列出会话；`cardbush --resume ID` 恢复会话，兼容原有 `--session ID`。正在执行的任务继续读取原任务事件，不重复派发。
- 正常退出、Ctrl+C 退出或任务报错后，只要已经有会话，都会显示 `cardbush --resume ID`；终端中的 ID 使用蓝色，重定向或设置 `NO_COLOR` 时输出纯文本。
- `--models`、`--projects` 列出可选项；`--model ID` 选择模型，`--project ID` 为新会话指定已有服务器项目。跨机器连接时用 `--project` 指定服务器目录，CLI 不上传或映射本地目录。
- Ctrl+C 在执行时停止当前任务，空闲时退出；Esc 在执行时停止且保留草稿，空闲时清空草稿。审批和提问临时接管输入，完成后恢复原草稿；未完成的粘贴不会串入审批答案。默认权限为 `task_free`，`--full-access` 对应 `all_free`。恢复会话默认申请审批，需要完全访问时重新传入 `--full-access`。
- 提问支持单题或最多 3 题一组。CLI 按顺序询问，收齐后统一提交；输入 `/cancel` 取消整组，已填写的部分不会发送。桌面和 Web 卡片支持前后切换、保留答案并在最后提交全部。
- `--prompt "问题"` 执行一轮后退出；管道或输入重定向将整个标准输入作为一条提示，适合多行内容。回复写到 stdout，状态和提示写到 stderr。
- 本地 Runtime 和 MCP 后台日志单独写入 CLI 数据目录的 `logs/runtime.log`，不会覆盖正在编辑的输入行。复用诊断脱敏及轮转：每份最多 8 MiB，保留当前文件与 3 份历史文件，跨日也轮转。任务状态、工具失败及启动失败仍正常提示；远程服务原有日志输出保持不变。
- 管道模式遇到审批或提问会停止本次任务，退出码为 2；用终端恢复会话后继续。成功为 0，错误为 1，停止为 130。

例如：

```sh
cardbush --prompt "检查当前项目" > reply.md
cardbush --resume <会话ID> --full-access
```

也可以连接已经启动并配置模型的 Agent 服务：

```sh
cardbush --url "<服务地址>" --token-file "<令牌文件>"
```

首次显式使用 `--token-file` 连接成功后，将地址、Agent 身份和令牌文件的绝对位置保存到 `~/.cardbush/cli.json`，不复制令牌或模型密钥。之后无需再次传参；使用 `--local` 可忽略保存的服务连接与连接环境变量。`CARDBUSH_CLI_CONFIG` 可指定独立的 CLI 连接配置文件。

原有 `CARDBUSH_AGENT_TOKEN`、`CARDBUSH_AGENT_URL` 仍可使用；选择服务模式而未指定地址时默认 `http://127.0.0.1:4780`。切换到其他服务地址不会自动复用已保存的令牌，也不会静默切回本地运行。连接远端使用 HTTPS 或已有 SSH 隧道。未注册命令时仍可使用 `node <程序目录>/bin/cardbush.mjs` 或 `npm run agent:chat -- ...`；直接运行 `cardbush` / Node 时保留终端当前目录。

### 部署与检查

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
