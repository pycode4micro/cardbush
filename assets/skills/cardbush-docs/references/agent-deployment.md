# CardBush 核心服务与 CLI 部署

部署同一个 `cardbush` npm 包，其中包含 Agent 核心服务和 CLI，无需 CardBush GUI。部署步骤由 Agent 或用户按本文执行；核心不负责创建系统账户、注册系统服务、安排开机启动或安装第三方插件依赖。

## 安装和启动

目标主机安装 Node.js 24 和 npm 10+。用户指定版本时安装该版本，否则使用当前发布版本：

```sh
npm install -g cardbush
cardbush --version
cardbush serve --help
cardbush serve --background
cardbush serve --status
```

也可安装经过验证的 Agent + CLI tarball：`npm install --global /absolute/path/cardbush-VERSION.tgz`。一次安装同时提供 `cardbush` 与 `cardbush-agent`，更新包时两个命令一起更新；安装目录与数据目录分离，按下方维护流程等待任务结束后重启服务。

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

Linux 的文件工具及已启用的命令隔离依赖 bubblewrap。由主机管理员按发行版安装，例如 Debian/Ubuntu 使用 `sudo apt-get install bubblewrap`；需允许实际运行用户创建相应命名空间。安装程序存在不等于可运行，必须检查实际沙箱结果。需要开机自启时，由部署方用已有 systemd 等服务管理器托管 `cardbush serve --data-dir ...` 前台命令，不要再套 `--background`。

当前 Linux 边界与不足：

| 项目 | 当前能力与限制 |
| --- | --- |
| 文件与命令隔离 | 已有 bubblewrap 后端、目录/单文件授权和路径身份检查；并非没有沙箱 |
| 主机依赖 | bubblewrap 及用户命名空间由主机提供；内核、容器、AppArmor/SELinux 策略可能阻止启动，核心不会自动放宽这些策略 |
| 系统调用过滤 | 当前命令沙箱没有额外 seccomp 过滤，不能宣称与其他 Linux 沙箱完全等价 |
| 资源限制 | 有启动准入和进程组清理，但没有 Windows Job Object 同等的内核 CPU、内存与进程数配额；需要硬配额时由现有系统服务或容器配置 |
| 验收范围 | 不能把 Windows 回归通过计为 Linux 实机通过；Linux 就绪探针也不能替代目标项目中的文件、网络和停止清理验证 |

两端沙箱初始化失败都拒绝受限操作，不回退宿主执行。文件内容访问独立要求可用沙箱，不能通过关闭终端沙箱来恢复文件工具。命令沙箱也不表示所有 MCP、插件、浏览器和宿主功能都已被隔离。

## 配置与连接

连接令牌和模型 API 密钥用途不同：

- `DATA_DIR/access-token` 由服务首次启动生成，用于连接这个 Agent；通过受保护的配置入口使用，不贴进聊天或日志。
- `DATA_DIR/config/models.json` 保存该 Agent 的模型配置。连接后的设置使用现有模型配置流程；保留已有配置，不从部署机器复制私人密钥。

同机 CLI 可连接服务：

```sh
cardbush --url http://127.0.0.1:4780 --token-file /path/to/agent-a/access-token
```

CardBush App 在「Agents → 添加 Agent」使用服务地址和令牌。跨机器使用已有 SSH 隧道或 HTTPS 反向代理，步骤见 [网络接入](agent-network-security.md)；默认不开放公网端口。CLI 不连接服务时，直接运行 `cardbush`，继续使用原来的本地共享 Runtime。

默认不安装、同步或修复第三方插件。用户单独要求插件操作时才阅读 [插件管理](plugin-management.md)，按插件自己的说明处理依赖。第三方插件是否全部就绪，不是核心安装的前置条件。

## 验收、更新与恢复

验收核心包应确认 CLI 帮助可用、服务经过鉴权可连接、实际进程没有 GUI、原配置/实例 ID/会话保留，以及启动、停止、再次启动正常。检查目标主机的沙箱状态；有授权的工作区时再验证实际文件与终端读写。未配置模型时明确只验证了核心运行，不虚构模型对话成功，不为例行检查额外调用收费模型。

更新前等待当前任务结束，保留原 npm 版本号和数据备份，再执行：

```sh
cardbush serve --stop
npm install -g cardbush@目标版本
cardbush serve --background
cardbush serve --status
```

自定义数据目录的实例在每条管理命令中使用相同 `--data-dir`。由外部服务管理器托管的实例通过原管理器停止和重启，避免它自动拉起旧进程。不删除 `agent.lock`、不清空配置或历史来解决启动失败。回退先停当前进程，再安装原版本并使用原目录；涉及数据格式变化时先确认兼容性，不能覆盖备份后的新数据。

## 从源码构建核心包

开发和未发布版本使用仓库现有构建入口：

```sh
npm ci --ignore-scripts
npm run package:agent -- --out /new/output/directory
```

完整目录包包含服务、CLI、工作区包、内置资源、Windows 原生组件和本 Skill。在目标平台执行 `npm ci --omit=dev --ignore-scripts` 后可用 `npm link --ignore-scripts` 注册命令；不要跨平台复制 `node_modules`，也不要只复制一个 `.mjs`。Windows 原生构建需使用对应 Windows 构建环境。npm 发布沿用现有发布流程，普通部署不创建另一套安装器。

直接在源码目录运行时，可在 `npm ci --ignore-scripts` 后执行 `npm run build:agent`，再用 `npm link --ignore-scripts` 注册两个命令，并用 `cardbush serve --help` 检查入口。
