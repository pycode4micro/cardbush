# CardBush 核心服务与 CLI 部署

部署 CardBush 的 Agent 核心服务和 CLI，无需 CardBush GUI。可以直接安装匹配的 npm 发行版，也可以在部署时从源码构建，无需用户预先准备压缩包。部署步骤由 Agent 或用户按本文执行；核心不负责创建系统账户、注册系统服务、安排开机启动或安装第三方插件依赖。

本文跟随当前源码；新的 worker 注册与交互协议尚未包含在已发布的 npm 1.0.13 中。需要这些能力时，在两端部署匹配的新构建；先核对实际帮助和服务能力，不把旧包当作已支持。

## 选择程序来源

先确认本机实际版本、所需能力和可访问的程序来源，不默认要求用户提供 tarball，也不将“复制本机 Agent”理解成复制正在使用的数据目录。

| 已有条件 | Agent 执行的部署路径 |
| --- | --- |
| 对应能力已有匹配 npm 发行版 | 在目标主机直接安装核对过的固定版本，如 `npm install -g cardbush@VERSION`，无需先在本机下载或打包。 |
| 有完整本机源码，包含待部署的未发布修改 | 检查实际源码与构建环境，在部署时构建独立运行目录或临时 npm 包，验证后传输；用户不必提前打包。只有已提交内容时也可让目标机取得同一修订后构建，不将本机未提交修改误当成远端已有。 |
| 已有经过验证的目录包或 tarball | 核对版本、构建身份、平台资源与校验值后复用；压缩只是传输/安装方式之一。 |
| 只有桌面 EXE/已安装 App，且没有匹配发行版或完整源码 | 先查找该版本的可信发行资源或可访问源码；当前没有从桌面 EXE 自动导出跨平台 Agent 的入口，不通过复制 EXE、`app.asar` 或用户数据冒充纯净部署。缺少来源时说明缺项。 |

有源码时可直接在目标主机构建并运行，或者先生成独立目录再传输；均不要求生成 `.tgz`。跨平台部署由目标机安装其平台依赖，具体命令见[源码构建](#从源码构建核心包)。程序与数据分开，新实例生成自己的身份与连接令牌；模型、私人插件和其他凭据仅按明确授权单独配置。

## 安装和启动

目标主机安装 Node.js 24 和 npm 10+。先核对目标能力已包含在选定版本中，再安装该版本；普通已发布功能才可使用当前发布版本：

```sh
npm install -g cardbush
cardbush --version
cardbush serve --help
cardbush serve --background
cardbush serve --status
```

也可安装经过验证的 Agent + CLI tarball：`npm install --global /absolute/path/cardbush-VERSION.tgz`。一次安装同时提供 `cardbush` 与 `cardbush-agent`，更新包时两个命令一起更新；安装目录与数据目录分离，按下方维护流程等待任务结束后重启服务。

若选择 tarball，可由 Agent 在此次部署中从指定源码构建，也可使用已有候选包；传输前后核对同一 SHA-256，同样的版本字符串不能证明两份候选包内容相同。Linux 可用 `sha256sum 文件`，Windows 可用 `Get-FileHash -Algorithm SHA256 文件`。直接源码构建则记录源码修订及本次本地修改范围。通过 `cardbush --version`、`cardbush worker --help` 和服务能力核对实际安装，不能依赖开发目录的依赖或只核对源码版本。目标平台的第三方依赖仍由 npm 安装，不跨平台复制 `node_modules`。

`--background` 直接静默启动 Node 服务，确认 HTTP 就绪后返回。关闭启动终端后服务继续运行；它不自动注册开机启动，也不改变运行账户。`--status` 显示地址、PID、数据目录、连接令牌文件、模型配置和日志路径，不输出密钥。旧版本的帮助中没有 `--background` 时先更新，不把该版本当作已经支持后台命令。

默认监听 `127.0.0.1:4780`，数据保存在当前用户的 `~/.cardbush/service`。已有部署使用原数据目录；多个实例分别指定目录和端口：

```sh
cardbush serve --background --data-dir /path/to/agent-a --port 4781
cardbush serve --status --data-dir /path/to/agent-a
cardbush serve --stop --data-dir /path/to/agent-a
```

`--stop` 通过带鉴权的服务请求关闭 Runtime 和当前任务，保留配置与会话；不按残留 PID 文件强杀其他进程。重复启动会连接已经运行的同一实例，不重复启动 Runtime。不带 `--background` 时在当前终端前台运行。已有 `cardbush-agent` 命令指向相同服务入口。

## Windows / Windows Server

终端工具使用 PowerShell 7（`pwsh`），不支持 Windows PowerShell 5。缺失时提示安装 PowerShell 7，不尝试换回 `powershell.exe`。核心后台启动直接使用 Node，不弹出 PowerShell 窗口。

在目标主机的既定运行用户下执行：

```powershell
node --version
pwsh --version
npm install -g cardbush
cardbush serve --background --data-dir 'C:\cardbush\data\agent-a'
cardbush serve --status --data-dir 'C:\cardbush\data\agent-a'
```

沿用已有账户和启动环境，不用部署/SSH 登录用户替换已有运行账户。需要系统安装权限时，按主机正常管理员授权流程处理。需要登录启动或系统托管时，由部署方使用 Windows 自带机制托管同一前台命令；核心不再提供另一套账户或计划任务管理层。后台运行并不保证注销或重启后自动启动。

Windows 已有 AppContainer 文件/命令沙箱和原生 Job Object 资源保护，所需原生组件随包提供。PowerShell 7 必须在实际运行账户下可用。部分 Session 0 服务环境曾出现进程初始化失败 `0xC0000142`；必须在真实启动场景验收，不能用 SSH 用户或另一个 Shell 成功代替，也不能关闭沙箱或退回宿主执行来掩盖。

## Linux

在目标主机已有普通用户下安装、运行相同 npm 包。使用 Linux 原生 Shell，不要求安装 PowerShell：

```sh
node --version
npm install -g cardbush
cardbush serve --background --data-dir "$HOME/.cardbush/service"
cardbush serve --status --data-dir "$HOME/.cardbush/service"
```

希望与已有全局安装隔离时，可在已有普通用户目录安装已验证的包。以下是 Linux 示例，替换 tarball 路径；Node/npm 必须在该用户的启动环境中可用：

```sh
CARDBUSH_DEPLOY_ROOT="$HOME/.local/share/cardbush-worker"
npm install --global --prefix "$CARDBUSH_DEPLOY_ROOT/installation" --ignore-scripts --no-audit --no-fund /absolute/path/cardbush-VERSION.tgz
"$CARDBUSH_DEPLOY_ROOT/installation/bin/cardbush" --version
"$CARDBUSH_DEPLOY_ROOT/installation/bin/cardbush" serve --background --data-dir "$CARDBUSH_DEPLOY_ROOT/data" --name Worker-A --host 127.0.0.1 --port 4780 --sandbox required
"$CARDBUSH_DEPLOY_ROOT/installation/bin/cardbush" serve --status --data-dir "$CARDBUSH_DEPLOY_ROOT/data"
```

若使用用户目录内的 Node 发行包，核对来源、固定版本、架构和官方校验值，并在启动脚本中显式保留该 Node 的 PATH；登录 Shell 可运行不等于后台服务或 systemd 可找到 Node。不要为此次部署替换其他服务使用的系统 Node。

Linux 的文件工具及已启用的命令隔离依赖 bubblewrap。先检查 `command -v bwrap` 和实际沙箱状态；缺失时由管理员按发行版安装。Debian/Ubuntu 可先用 `apt-get --simulate install --no-install-recommends bubblewrap` 预览，再在已授权范围内执行 `sudo apt-get install --no-install-recommends bubblewrap`。预览若出现其他升级或移除，先明确实际影响，不将其包含在“只安装 bubblewrap”的结论中。

安装程序存在不等于沙箱可运行，必须检查实际运行用户的命名空间和文件操作回执。需要开机自启时，由部署方用已有 systemd 等服务管理器托管 `cardbush serve --data-dir ...` 前台命令，保留原端口、沙箱参数和运行环境，不要再套 `--background`。

### Ubuntu AppArmor 阻止用户命名空间

Ubuntu 24.04 的用户命名空间限制可能使已安装的 bwrap 仍无法启动。先检查失败回执和内核/AppArmor 拒绝日志，区分缺少可执行文件、AppArmor、容器限制或其他内核策略，不把所有 `Operation not permitted` 都归为同一原因。机制见 [Ubuntu 官方说明](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions)。

确认是 AppArmor 且没有适用的现有规则后，可准备针对实际 bwrap 路径的例外供管理员审阅。下面示例曾用于 `/usr/bin/bwrap`；先核对 `readlink -f "$(command -v bwrap)"` 和已有 profile，不覆盖发行版或其他应用规则：

```text
abi <abi/4.0>,
include <tunables/global>

profile cardbush-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

这是一条允许该可执行文件使用用户命名空间的例外，不是完整的 AppArmor 限制策略，也不只影响 CardBush 或单个用户。先在临时文件上用 `apparmor_parser -Q -K /absolute/path/cardbush-bwrap` 检查语法；仅在授权覆盖这一系统策略修改时，才安装为 root 所有、0644 的 `/etc/apparmor.d/cardbush-bwrap` 并以 `sudo apparmor_parser -a -K /etc/apparmor.d/cardbush-bwrap` 加载新规则。已有规则的更新走管理员原有流程。已有明确授权无需重复索取。

加载后重试实际运行用户的沙箱探针和工作区文件任务，确认回执为 `linux-bubblewrap` 且网络策略符合配置。失败则保留诊断，不全局关闭 AppArmor、放开所有用户命名空间或退回无沙箱执行。

当前 Linux 边界与不足：

| 项目 | 当前能力与限制 |
| --- | --- |
| 文件与命令隔离 | 已有 bubblewrap 后端、目录/单文件授权和路径身份检查；并非没有沙箱 |
| 主机依赖 | bubblewrap 及用户命名空间由主机提供；内核、容器、AppArmor/SELinux 策略可能阻止启动，核心不会自动放宽这些策略 |
| 系统调用过滤 | 当前命令沙箱没有额外 seccomp 过滤，不能宣称与其他 Linux 沙箱完全等价 |
| 资源限制 | 有启动准入和进程组清理，但没有 Windows Job Object 同等的内核 CPU、内存与进程数配额；需要硬配额时由现有系统服务或容器配置 |
| 验收范围 | 不能把 Windows 回归通过计为 Linux 实机通过；Linux 就绪探针也不能替代目标项目中的文件、网络和停止清理验证 |

两端沙箱初始化失败都拒绝受限操作，不回退宿主执行。文件内容访问独立要求可用沙箱，不能通过关闭终端沙箱来恢复文件工具。命令沙箱也不表示所有 MCP、插件、浏览器和宿主功能都已被隔离。

## 低内存主机与插件

预检可用内存、swap、当前服务进程和启用的 MCP/插件。`resource_memory_pressure` 是资源准入拒绝，应与沙箱、模型鉴权故障分开处理。一次 2 GB Linux 实测中，默认文档 MCP 进程及预留预算使文件工具无法获准启动；关闭不需要的 `docx`、`xlsx`、`pptx`、`pdf` 后，轻量 worker 文件任务通过。这是特定负载的实测结果，不是“2 GB 支持所有插件”的保证或最低配置承诺。

按实际职责和授权范围使用目标的应用/插件配置入口调整启用项，保留原配置并报告取舍；需要文档功能时减少并发或增加资源后重测。不要通过降低资源保护阈值、杀死无关进程或自动改宿主 swap 来让检查通过。低内存测试配置不能覆盖用户已有部署的插件选择。

## 配置与连接

连接令牌和模型 API 密钥用途不同：

- `DATA_DIR/access-token` 由服务首次启动生成，用于连接这个 Agent；通过受保护的配置入口使用，不贴进聊天或日志。
- `DATA_DIR/config/models.json` 保存该 Agent 的模型配置。由服务所有者在该主机配置，或通过受保护的目标模型管理入口保存；直接修改文件后重启加载。保留已有模型，不默认复制部署机器的私人密钥。

需要复用本机 API 模型时，先确认用户已指定目标主机、模型和传输授权；只复制该模型完整且必要的协议、地址、模型 ID、参数和凭据，设置服务端 `defaultModelId`，不要复制整个桌面配置目录。仅核对模型 ID、默认值和凭据存在性，不输出密钥或敏感请求头；POSIX 配置文件使用 owner-only 权限。API Key 与服务连接 token 不能互换；本机 ChatGPT 登录态、浏览器授权和 OAuth 存储不随连接迁移。

默认模型存在且一轮真实请求成功，才能声明模型配置通过。使用付费模型的测试需在用户授权范围内控制规模；缺少授权或密钥时先交付其他已完成项，不以 mock 的成功替代真实模型验证。

本机 CLI 将服务添加为远程 worker：

```sh
cardbush worker add --name Worker-A --url http://127.0.0.1:4780 --token-file /path/to/agent-a/access-token
cardbush worker list
```

CardBush App 在「Team → 员工 → 远程执行服务」添加连接并注册角色。CLI 与 App 目前各自保管连接；在执行父任务的宿主上注册，不跨宿主复制凭据。上面的回环 URL 仅用于服务所在主机；另一台机器上的 `127.0.0.1` 不指向服务器。跨机器优先使用 App 内置 SSH 连接，或 HTTPS 反向代理；手动转发仅按[网络接入](agent-network-security.md)的适用场景使用。直接运行 `cardbush` 始终使用所在主机的本机 Runtime，与独立 HTTP 服务的会话库分开；不再通过聊天参数 `--url` / `--token-file` 切换主助手。角色注册与消息交互见[远程 worker](remote-workers.md)。

默认不安装、同步或修复第三方插件。用户单独要求插件操作时才阅读 [插件管理](plugin-management.md)，按插件自己的说明处理依赖。第三方插件是否全部就绪，不是核心安装的前置条件。

## 验收、更新与恢复

验收核心包应确认 CLI 帮助可用、服务经过鉴权可连接、实际进程没有 GUI、原配置/实例 ID/会话保留，以及启动、停止、再次启动正常。云 worker 按[分层验收](remote-workers.md#分层验收)验证角色注册、真实委派、续接、沙箱文件任务和重启后的历史。未配置模型时明确只验证了核心运行，不虚构模型对话成功，不为例行检查额外调用收费模型。

关闭启动终端后仍运行、断线重连、服务进程重启和操作系统重启是不同检查。只完成前几项时，明确尚未验证开机自启；启动脚本应包含原安装路径、Node 环境、数据目录、监听地址、端口及沙箱策略。验收记录不能包含密码、token 或模型密钥。

更新前等待当前任务结束，保留原 npm 版本号和数据备份，再执行：

```sh
cardbush serve --stop
npm install -g cardbush@目标版本
cardbush serve --background
cardbush serve --status
```

自定义数据目录的实例在每条管理命令中使用相同 `--data-dir`。由外部服务管理器托管的实例通过原管理器停止和重启，避免它自动拉起旧进程。不删除 `agent.lock`、不清空配置或历史来解决启动失败。回退先停当前进程，再安装原版本并使用原目录；涉及数据格式变化时先确认兼容性，不能覆盖备份后的新数据。

## 从源码构建核心包

本节可由 Agent 在部署当次执行，不要求用户事先生成构建产物。需要 npm tarball 时使用仓库既有发布包构建和仓库外安装验证入口：

```sh
npm ci --ignore-scripts
npm run package:npm -- --out /new/output/directory
npm run verify:npm-package -- --tarball /new/output/directory/cardbush-VERSION.tgz
```

校验使用隔离配置与 mock 模型，检查注册委派和缓存清理后的 worker 历史；仍需在目标 OS 安装同一 tarball 并完成已授权的真实部署验收。打包不等于 npm 发布，内部试用无需先发布。独立目录包使用另一个已有入口：

```sh
npm ci --ignore-scripts
npm run package:agent -- --out /new/output/directory
```

完整目录包包含服务、CLI、工作区包、内置资源、本 Skill 及目标平台所需的原生组件。在目标平台执行 `npm ci --omit=dev --ignore-scripts` 后可用 `npm link --ignore-scripts` 注册命令；不要跨平台复制 `node_modules`，也不要只复制一个 `.mjs`。Windows 原生构建需使用对应 Windows 构建环境；当前通用 npm 包必须同时具备 Windows 原生资源，缺少时不强行生成不完整 tarball。仅部署 Linux 时可在 Linux 从源码构建或生成 Linux 目录包。npm 发布沿用现有发布流程，普通部署不创建另一套安装器。

直接在源码目录运行时，可在 `npm ci --ignore-scripts` 后执行 `npm run build:agent`，再用 `npm link --ignore-scripts` 注册两个命令，并用 `cardbush serve --help` 检查入口。
