# 命令执行沙盒

本轮实现了共用终端的操作系统隔离入口，并将工作区路径授权、终端会话管理、平台隔离和资源治理分开。桌面端与独立 Agent 的 `terminal_exec` 使用相同实现。项目仍在原来的目录中，不分区、不创建虚拟磁盘、不复制项目。

**桌面端和 Agent 服务检测到已安装且可用的命令沙盒后默认启用；尚未安装时不会自动下载。它不是整个 CardBush 的安全边界，也尚未达到 Codex 的全部防护覆盖。** Windows AppContainer 和 Linux bubblewrap 已完成真实进程测试；本次 Linux 验收使用 Ubuntu 24.04 的实际 Agent 服务账号和 `NoNewPrivileges=yes`，不代表其他发行版已经实测。运行时按能力探测，不按发行版名称分支。macOS 暂不支持，开启隔离时拒绝执行。

## 启用

在 **设置 → 运行环境 → 命令沙盒** 查看当前主机的探测结果、点击安装、开关和重新检测。云 Agent 使用相同面板，操作作用于服务器；旧服务会提示更新，不回退到本机。组件未安装、已安装但被系统策略阻止、可用和系统不支持分别显示。

启动和打开设置只进行固定无副作用命令的探测，不执行安装。Windows 组件随应用提供；缺失时需修复或更新应用。Linux 按主机实际可用且可信的包管理器识别安装方式，不设发行版名称白名单，也不要求 `/etc/os-release` 命中预置名称。Debian 系（apt-get）、Red Hat 系（dnf/dnf5/yum）和 Arch 系（pacman）及使用相同包管理器的衍生发行版走同一适配；另提供 zypper 和 apk 安装入口，扩大 SUSE/openSUSE、Alpine 系的覆盖。新发行版只要沿用已适配的包管理器，无需添加名称就能识别。检测不到受支持的可信入口时，保留禁用的安装按钮；即使没有安装入口，已经安装的 bubblewrap 仍按实际隔离能力判断是否可用。

点击安装后调用检测到的可信系统包管理器执行固定的 bubblewrap 安装命令。本地图形环境可调用系统授权窗口，服务账号需具备管理员安装权限；否则在设置中显示供管理员使用的命令。不会自动修改软件源、AppArmor、SELinux、内核参数或容器策略。包管理器检测成功不等于沙盒已经可用：软件源仍需提供 bubblewrap，安装后还需通过实际能力检查；失败时显示原因，不误报安装成功。新增安装入口的命令参考 [DNF5](https://dnf5.readthedocs.io/en/latest/dnf5.8.html)、[SUSE](https://opensource.suse.com/bci-docs/guides/package-management/) 和 [Alpine](https://wiki.alpinelinux.org/wiki/Bubblewrap) 官方文档。

安装和验证成功自动保存 `config/sandbox.json` 的启用状态；桌面配置位于 `product-host` 数据目录，Agent 位于自己的数据目录。已存在的关闭选择在重新检测和重启后保留。安装后使用 `auto` 策略，更改从下一条命令生效：正在运行或等待批准的命令使用原来的不可变配置。执行层读取宿主配置，不修改模型工具目录、系统提示词或历史消息。沙盒故障不会把此前启用的配置自动改为关闭。

以下命令与环境变量保留给部署管理员，日常用户无需配置启动参数：

独立 Agent 启动时增加：

```sh
node dist-electron/agentServiceCli.mjs \
  --data-dir /srv/cardbush/agent-a \
  --sandbox auto --sandbox-network disabled
```

桌面端和 Agent 服务也可以在启动环境中配置以下变量。它们由实际运行 Runtime 的宿主读取，不属于模型参数或会话设置；修改后需重启宿主。

桌面端也支持启动参数 `--execution-sandbox=auto`，可放在此安装的快捷方式中；已设置的 `CARDBUSH_EXECUTION_SANDBOX` 优先于此参数。`auto` 是可由设置开关调整的默认策略；显式 `off` 和 `required` 是管理员锁定策略，界面不可覆盖。该方式不会改变其他旧版本安装的环境变量。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `CARDBUSH_EXECUTION_SANDBOX` | 跟随宿主安装与设置状态 | `auto`：申请批准时隔离、完全访问时使用普通进程；`required`：所有模式强制隔离，拒绝会话扩权；显式 `off` 锁定为关闭。未接入设置的独立 Runtime 库仍默认 `off`。要求隔离时初始化失败均拒绝命令，不重试为普通进程 |
| `CARDBUSH_SANDBOX_NETWORK` | `disabled` | `disabled` 禁止命令联网；`enabled` 允许后端支持的联网，不提供域名白名单 |
| `CARDBUSH_SANDBOX_READ_ROOTS` | `[]` | JSON 格式的绝对目录列表，额外可读、可执行的工具或参考目录 |
| `CARDBUSH_SANDBOX_WRITE_ROOTS` | `[]` | JSON 格式的绝对目录列表，额外可写目录 |
| `CARDBUSH_BWRAP_PATH` | 从宿主 PATH 发现 | Linux bubblewrap 的绝对路径。解析后的二进制及父目录必须由 root 管理且不可由组或其他用户写入；不使用模型命令的 PATH 或工作目录 |

会话当前工作区是默认可写范围，临时 HOME、配置和缓存使用每次命令独立的普通临时目录。目录会解析真实路径；磁盘根目录、Windows 网络共享、文件路径及包含沙盒管理日志的宽泛目录不能作为授权根。

`auto` 中，`terminal_exec.additional_permissions` 可请求额外只读目录、可写目录或联网；范围外的 `cwd` 会明确申请该目录的写权限。审批绑定命令、解释器、真实工作目录和完整执行策略，只作用于此次进程及其子进程；下一条命令恢复基础范围。审批前后链接目标变化会拒绝执行。没有批准就不会启动，拒绝后不自动重试。网络目前是全部目的地开／关，审批卡片会明确显示，不表示域名授权。

`required` 是部署管理员设置的硬上限：越界请求直接说明宿主限制，避免先弹出无法兑现的审批；`all_free`、工具参数、`taskRoots`、`userRoots` 都不能取消该限制。`off` 下未隔离命令仍须按申请批准模式精确确认。

Windows `auto` 模式自动加入宿主选定的 shell 安装目录为只读范围。其他安装在用户目录中的 Node、Python 等工具，可配置或申请其**具体安装目录**，避免放开整个用户目录。命令不会继承宿主服务令牌、模型密钥、代理凭据、`NODE_OPTIONS`、`LD_PRELOAD` 或用户启动配置；依赖这些配置的工作流需要单独设计受控授权。

## 各环境的实际范围

- **Windows**：每次命令使用一次性 AppContainer 身份。对指定目录设置该身份的临时 ACL；子进程继承隔离。无网络能力时，Windows 阻止 socket 联网。命令挂起创建，在既有 Job Objects 资源约束就绪后才运行。不需要管理员初始化或关闭智能应用控制。此实现采用 AppContainer，和 Codex 官方文档中的专用低权限用户方案不同。
- **Linux**：从可信宿主 PATH 发现 bubblewrap，也可由管理员指定路径。先以当前服务账号运行固定无副作用探针，检查用户、进程、IPC、UTS 和所需网络命名空间；失败返回后端原因，不尝试关闭 AppArmor、SELinux 或容器策略。用户命令使用系统工具及必要配置的只读挂载，工作区直接绑定原路径，不挂载宿主 `/`、真实用户 HOME 或 `/run`。非 FHS 工具目录可由宿主显式配置只读根。当前没有额外 seccomp 系统调用过滤，不能宣称与 Codex Linux 沙盒等价。
- **普通 SSH 项目**：客户端无法限制服务器上的 shell。启用 `required` 后，在没有远端沙盒能力握手的情况下拒绝 SSH `terminal_exec` 和 `terminal_write`，保留查询、停止等管理操作。可以连接由管理员开启沙盒的独立 CardBush Agent，在服务器上执行。
- **独立云 Agent**：HTTP/SSH 只是连接方式，隔离由服务器 Runtime 实施。桌面设置或子代理参数不能关闭服务器的 `required` 策略；远程 Agent 也不继承本机目录授权。

### 发行版部署差异

通过目标发行版的软件管理方式安装 bubblewrap，再用服务账号运行本文的实机测试。运行时不执行包管理器，也不修改系统安全策略。后端的启动探针仅运行固定 Node 空程序，可读取宿主基础文件来检验命名空间；它不会执行用户命令。

本次 Ubuntu 24.04 机器的 AppArmor 缺少 bubblewrap 的用户命名空间授权。部署时安装了 [专用示例规则](deployment/cardbush-bwrap.apparmor)，只匹配该机系统二进制 `/usr/bin/bwrap`，保留 `kernel.apparmor_restrict_unprivileged_userns=1`。此文件是 Ubuntu/AppArmor 部署示例，不会被 Runtime 自动安装，也不应直接套用到 SELinux 主机或其他安装路径。依据 [Ubuntu AppArmor 文档](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/) 调整应用权限；已有发行版规则时优先使用它。

终端返回和 `terminal_list` 中的 `sandbox` 字段表示该终端要求的隔离后端及网络策略；未要求隔离时为 `null`。它与资源限制分开：Windows 继续使用原来的内存、CPU、进程数和进程树预算；Linux 不能据此宣称具有 Windows Job Object 同等的内核资源配额。

## 生命周期与构建

Windows ACL 修改按执行账号串行处理，覆盖同时使用同一项目及嵌套项目的情况。命令退出或被停止后，仅清理本次身份的权限，不恢复可能覆盖其他会话更改的旧 ACL。杀死宿主导致其 `finally` 未执行时，Runtime 会启动清理入口。清理失败保留 `cardbush-sandbox-*/policy.json` 并返回错误。

机器断电或 Runtime 与原生宿主同时被强制杀死的自动恢复尚未实现。此时的一次性身份不会被后续命令复用，但可能遗留 ACL 和配置。确认对应任务已结束后，可由维护人员使用同版本原生宿主的 `--sandbox-cleanup <policy.json>` 清理；不要在运行期间删除日志，也不要直接恢复整棵项目的 ACL。

原生构建先编译为不可变版本文件，再运行 `--capabilities` 检查；新文件不能启动或版本不兼容时，保留原来的发布清单。签名和 Windows 应用控制仍是发布要求；一次开发机测试通过不代表文件已获得发行签名或其他机器必定允许执行。旧版宿主不能用于强制沙盒，能力检查会拒绝。

## 验证与待办

在仓库根目录运行：

```sh
npm run build --workspace @cardbush/bush-runtime
node --test packages/bush-runtime/test/commandSandboxPolicy.test.mjs packages/bush-runtime/test/commandPermission.test.mjs packages/bush-runtime/test/commandSandboxLive.test.mjs packages/bush-runtime/test/executionSandbox.test.mjs
```

Windows 原生测试覆盖实际文件读写、只读目录、junction、子进程、socket、宿主环境变量隔离、cmd/PowerShell、并发嵌套根、停止清理和 ACL 恢复。后端缺失的测试验证不执行命令且释放资源额度。Linux 测试在 Linux 主机上真实运行 bubblewrap，缺失后端不会静默跳过或算作通过；停止还覆盖脱离进程组的后代。两端都实测了获批扩权、只读授权、拒绝、下一条命令恢复边界和完全访问。

设置 `CARDBUSH_SANDBOX_LIVE_NETWORK=HOST:PORT` 可额外验收已知可达的 TCP 目标：先测宿主连通性，再依次验证沙盒断网、允许联网、再次断网。本次 Windows 使用现有服务器 SSH 端口，Linux 使用本机 Agent 端口，均通过；测试不发送应用数据。未设置此变量时该项明确跳过。

2026-09-23 开发过程中，一轮合并回归的测试程序被 Windows 应用控制拦截，Code Integrity 事件 3077 和原生错误 4551 指向未满足签名要求，该轮 11 项未完成。提交前复核的 76 项本机回归全部通过，覆盖 Windows 沙盒、资源治理、审批、终端和 SSH；从 Runtime 包目录启动沙盒测试也通过。Linux 实机项在 Windows 上跳过，仍不能记为 Linux 验收通过。整个过程未关闭系统防护或更换启动方式绕过拦截；开发测试通过也不代表发行签名问题已解决。CI 已增加 Windows/Linux 真实沙盒测试，Linux 构建安装 bubblewrap。

默认启用以当前主机实际探测通过为前提，后续仍需完成：更多 Linux 环境验收、发行签名、崩溃恢复、受保护配置和项目内已有硬链接的安全策略、更多语言运行时兼容性及大型项目 ACL 更新开销测量。Windows 系统已有的 AppContainer 公共资源权限仍可能可读；项目内的敏感文件也不会被此实现自动识别或隐藏。

文件工具继续使用原有路径审批，不受本次子进程沙盒直接控制。插件 hooks、stdio MCP、浏览器、Computer Use 和宿主辅助进程的接入仍需逐项处理，不能把“命令沙盒”宣传成所有工具都已隔离。

设计依据见 [调研与模块边界](EXECUTION_SANDBOX_PLAN.md)；Windows 使用 [Microsoft AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) 系统接口。
