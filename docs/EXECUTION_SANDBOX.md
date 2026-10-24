# 命令与工作区文件沙箱

终端、文件内容读写和本地 rg 搜索共用进程沙箱后端、资源治理及退出清理。授权、文件版本冲突检测和补丁回滚由 Runtime 协调，内容 I/O 在受限子进程内完成。桌面端与独立 Agent 使用相同实现。项目仍在原来的目录中，不分区、不创建虚拟磁盘、不复制项目。

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

`auto` 中，`terminal_exec.additional_permissions` 可通过 `read_roots` / `write_roots` 请求目录，或通过 `read_files` / `write_files` 请求已有的单个文件，也可请求联网。单文件授权不扩大为父目录授权，不提供兄弟文件访问、创建或删除权限；需要新建单文件时使用 `write_file`。范围外的 `cwd` 仍会明确申请该目录的写权限。审批绑定命令、解释器、真实工作目录、文件身份和完整执行策略，只作用于此次进程及其子进程；下一条命令恢复基础范围。审批前后链接目标或文件对象变化会拒绝执行。没有批准就不会启动，拒绝后不自动重试。网络目前是全部目的地开／关，审批卡片会明确显示，不表示域名授权。

`required` 是部署管理员设置的硬上限：越界请求直接说明宿主限制，避免先弹出无法兑现的审批；`all_free`、工具参数、`taskRoots`、`userRoots` 都不能取消该限制。`off` 下未隔离命令仍须按申请批准模式精确确认。

Windows `auto` 模式自动加入宿主选定的 shell 安装目录为只读范围。其他安装在用户目录中的 Node、Python 等工具，可配置或申请其**具体安装目录**，避免放开整个用户目录。命令不会继承宿主服务令牌、模型密钥、代理凭据、`NODE_OPTIONS`、`LD_PRELOAD` 或用户启动配置；依赖这些配置的工作流需要单独设计受控授权。

## 各环境的实际范围

- **Windows**：每次命令使用一次性 AppContainer 身份，私有目录不会在命令间共享。终端通过独立的目录 capability 复用相同读写范围的 ACL 准备；每条命令仍只获得本次已批准范围对应的 capability，网络权限单独设置，子进程继承隔离。无网络能力时，Windows 阻止 socket 联网。命令挂起创建，在既有 Job Objects 资源约束就绪后才运行。不需要管理员初始化或关闭智能应用控制。此实现采用 AppContainer，和 Codex 官方文档中的专用低权限用户方案不同。
- **Linux**：从可信宿主 PATH 发现 bubblewrap，也可由管理员指定路径。先以当前服务账号运行固定无副作用探针，检查用户、进程、IPC、UTS 和所需网络命名空间；失败返回后端原因，不尝试关闭 AppArmor、SELinux 或容器策略。用户命令使用系统工具及必要配置的只读挂载，工作区直接绑定原路径，不挂载宿主 `/`、真实用户 HOME 或 `/run`。非 FHS 工具目录可由宿主显式配置只读根。当前没有额外 seccomp 系统调用过滤，不能宣称与 Codex Linux 沙盒等价。
- **普通 SSH 项目**：客户端无法限制服务器上的 shell。启用 `required` 后，在没有远端沙盒能力握手的情况下拒绝 SSH `terminal_exec` 和 `terminal_write`，保留查询、停止等管理操作。可以连接由管理员开启沙盒的独立 CardBush Agent，在服务器上执行。
- **独立云 Agent**：HTTP/SSH 只是连接方式，隔离由服务器 Runtime 实施。桌面设置或子代理参数不能关闭服务器的 `required` 策略；远程 Agent 也不继承本机目录授权。

### 发行版部署差异

通过目标发行版的软件管理方式安装 bubblewrap，再用服务账号运行本文的实机测试。运行时不执行包管理器，也不修改系统安全策略。后端的启动探针仅运行固定 Node 空程序，可读取宿主基础文件来检验命名空间；它不会执行用户命令。

本次 Ubuntu 24.04 机器的 AppArmor 缺少 bubblewrap 的用户命名空间授权。部署时安装了 [专用示例规则](deployment/cardbush-bwrap.apparmor)，只匹配该机系统二进制 `/usr/bin/bwrap`，保留 `kernel.apparmor_restrict_unprivileged_userns=1`。此文件是 Ubuntu/AppArmor 部署示例，不会被 Runtime 自动安装，也不应直接套用到 SELinux 主机或其他安装路径。依据 [Ubuntu AppArmor 文档](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/) 调整应用权限；已有发行版规则时优先使用它。

终端返回和 `terminal_list` 中的 `sandbox` 字段表示该终端要求的隔离后端及网络策略；未要求隔离时为 `null`。它与资源限制分开：Windows 继续使用原来的内存、CPU、进程数和进程树预算；Linux 不能据此宣称具有 Windows Job Object 同等的内核资源配额。

Windows PowerShell 启动时核对实际位置与进程 cwd。不一致时，在已授权 cwd 上建立 `CardBushWorkspace:` 文件系统盘并切换位置；不为此授予父目录访问权限。相对路径和原生子进程使用正确的目录；需要将 PowerShell 位置传给原生程序时，使用 `(Get-Location).ProviderPath` 获取磁盘路径。初始化失败在执行用户命令前终止。终端回执的 `phase` 区分 `preparing_sandbox`、`executing`、`cleaning_up` 和 `finished`，权限准备及回收不会伪装成命令正在计算。

终端的 PowerShell 错误诊断包装复用已经初始化的 `ProviderPath`，仅在它与进程 cwd 不一致时切换位置，避免重新解析绝对路径而触碰未授权父目录。错误诊断仍区分目录初始化失败和用户命令失败；父目录元数据与目录列表保持未授权。

## 生命周期与构建

Windows ACL 修改按执行账号串行处理，覆盖同时使用同一项目及嵌套项目的情况。终端目录授权按规范化后的精确读/写根和原生宿主版本复用，最多保留 8 份闲置授权，闲置 60 秒后回收。扩大范围的临时批准不会被后续普通命令继承。首次授权与最终回收仍需遍历继承 ACL，但连续命令不再重复付出这部分成本。原生授权进程保持目录及祖先的宿主句柄，防止授权期间路径被改名或替换；这些句柄不传给沙箱，也不增加沙箱对父目录的访问权。工作区终端关闭及 Runtime 关闭会等待回收完成。

权限范围切换会更新当前账号的授权代号，跨 Runtime、跨 Windows 登录会话协调。代号和范围摘要保存在宿主的 `HKCU\Software\CardBush\SandboxScopeGeneration`，不授予沙箱读写此键的能力。Windows 移动文件可能保留原 ACL，因此旧代号对应的 capability 不能再发给新命令：原生宿主在创建令牌前检查，过期时改用本次一次性身份完成隔离执行，并使缓存退出复用。已运行命令保留自己的原授权；不重复执行用户命令。

只读文件助手和无删除权限的单文件内容编辑不会改变目录授权代号。原生宿主还登记正在运行的目录写入进程：存在不同范围的写入者时不向新命令发放缓存 capability；写入者结束时使期间创建的不同范围缓存失效。异常退出的写入者按进程存活状态回收，同时使旧代号失效；无法确认进程已退出时保守处理。这覆盖“大范围命令先启动、小范围缓存后创建、随后移出文件”的交错顺序。当前原生协议要求 `sandboxScopeVersion: 3`，旧组件在启动检查中被拒绝。升级后须重启使用旧代码的 Runtime（包括共享本地 Runtime 和桌面进程），新开一个连接旧 Runtime 的 CLI 窗口不足以加载修复。

文件助手与 rg 使用独立、最多 2 个进程的 I/O 配额，队列最多 256 项并支持取消；终端仍使用自己的任务配额。所有类别共用内存、CPU、进程数限制，I/O 启动预留为 64 MiB，系统内存预留没有降低。资源不足仍明确拒绝，不改用宿主执行。排队不消耗搜索/短命令的实际执行超时；Windows 原生宿主提供阶段信号，准备和清理各自上限为 120 秒，不消耗执行预算，错误区分 `sandbox_setup_timeout`、执行超时和 `sandbox_cleanup_timeout`。已退出终端的 `terminal_stop` 只收取结果，不再申请停止权限；运行中的终端保持原审批。

命令退出或被停止后，仅清理本次独立身份的权限；授权到期仅清理该 capability，不恢复可能覆盖其他会话更改的旧 ACL。杀死命令宿主导致其 `finally` 未执行时，Runtime 会启动清理入口。清理失败保留 `cardbush-sandbox-*/policy.json` 并返回错误。目录授权进程独立于 libuv 的父进程退出清理组，通过固定的 Runtime 进程句柄和 stdin EOF 监测所有者，Runtime 崩溃后仍完成撤权。授权进程意外退出会终止依赖它的命令，Runtime 等待补偿清理；对应日志是 `cardbush-scope-*/policy.json`。

机器断电或 Runtime 与所有原生宿主同时被强制杀死的自动恢复尚未实现。此时的一次性身份和随机目录 capability 不会被后续 Runtime 复用，但可能遗留 ACL 和配置。确认对应任务已结束后，可由维护人员使用同版本原生宿主的 `--sandbox-cleanup <policy.json>` 清理命令日志，或 `--sandbox-scope-cleanup <policy.json>` 清理目录授权日志；不要在运行期间删除日志，也不要直接恢复整棵项目的 ACL。

原生构建先编译为不可变版本文件，再运行 `--capabilities` 检查；新文件不能启动或版本不兼容时，保留原来的发布清单。签名和 Windows 应用控制仍是发布要求；一次开发机测试通过不代表文件已获得发行签名或其他机器必定允许执行。旧版宿主不能用于强制沙盒，能力检查会拒绝。

## 验证与待办

在仓库根目录运行：

```sh
npm run build --workspace @cardbush/bush-runtime
node --test packages/bush-runtime/test/commandSandboxPolicy.test.mjs packages/bush-runtime/test/commandPermission.test.mjs packages/bush-runtime/test/commandSandboxLive.test.mjs packages/bush-runtime/test/executionSandbox.test.mjs packages/bush-runtime/test/windowsSandboxScope.test.mjs
```

Windows 原生测试覆盖实际文件读写、只读目录、junction、子进程、socket、宿主环境变量隔离、cmd/PowerShell、并发嵌套根、停止清理和 ACL 恢复。后端缺失的测试验证不执行命令且释放资源额度。Linux 测试在 Linux 主机上真实运行 bubblewrap，缺失后端不会静默跳过或算作通过；停止还覆盖脱离进程组的后代。两端都实测了获批扩权、只读授权、拒绝、下一条命令恢复边界和完全访问。

设置 `CARDBUSH_SANDBOX_LIVE_NETWORK=HOST:PORT` 可额外验收已知可达的 TCP 目标：先测宿主连通性，再依次验证沙盒断网、允许联网、再次断网。本次 Windows 使用现有服务器 SSH 端口，Linux 使用本机 Agent 端口，均通过；测试不发送应用数据。未设置此变量时该项明确跳过。

2026-09-23 开发过程中，一轮合并回归的测试程序被 Windows 应用控制拦截，Code Integrity 事件 3077 和原生错误 4551 指向未满足签名要求，该轮 11 项未完成。提交前复核的 76 项本机回归全部通过，覆盖 Windows 沙盒、资源治理、审批、终端和 SSH；从 Runtime 包目录启动沙盒测试也通过。Linux 实机项在 Windows 上跳过，仍不能记为 Linux 验收通过。整个过程未关闭系统防护或更换启动方式绕过拦截；开发测试通过也不代表发行签名问题已解决。CI 已增加 Windows/Linux 真实沙盒测试，Linux 构建安装 bubblewrap。

默认启用以当前主机实际探测通过为前提，后续仍需完成：更多 Linux 环境验收、发行签名、崩溃恢复、受保护配置和项目内已有硬链接的安全策略、更多语言运行时兼容性及大型项目 ACL 更新开销测量。Windows 系统已有的 AppContainer 公共资源权限仍可能可读；项目内的敏感文件也不会被此实现自动识别或隐藏。

目录授权复用回归额外覆盖临时扩权后恢复边界、移出工作区的文件不能沿用旧授权、私有目录互相不可读、并发取消、闲置回收、目录身份固定、授权进程中断、Runtime 强制退出及关闭期间的待启动命令。2026-10-24 最终构建在本机两万文件目录执行同一 `cmd /c cd`：一次性授权策略为 3.13–3.17 秒，目录授权首次准备为 1.65 秒，复用后为 0.21–0.23 秒；最终撤权另耗 1.53 秒。该结果来自隔离临时目录，不改变用户项目权限或原会话。

本地 `read_file`、`write_file`、`edit_file`、`apply_patch` 和 `search_file_content` 强制使用进程沙箱，默认断网；终端的 `off` / `all_free` 不关闭文件工具隔离。缺少后端、旧版宿主缺少单文件能力、资源准入失败或启动被系统拒绝，均明确报错，不回退宿主内容读写或 Node 搜索。路径审批绑定本次调用解析出的实际目标和文件身份；审批、排队后目标改变，返回 `workspace_authorization_changed`。补丁的源路径与移动目的地全部在首个内容写入前校验，保留文件资源锁、读取版本证据和补丁回滚。

Windows 保留 `--workspace-path-guard` 元数据入口固定目录及其祖先，拒绝重解析点替换。实际内容 I/O 由 AppContainer 内的 `--workspace-file-worker` 执行，进程只获得精确文件 ACL；原生能力握手要求 `sandboxFileVersion: 2`。Linux 使用目录描述符固定路径，保留元数据描述符防止 inode 重用；bubblewrap 挂载后，由固定的沙箱内启动器核对文件及目录身份，通过后才启动 rg、文件工作进程或获批的终端命令。这个校验在挂载后的命名空间内完成，兼容已有 bubblewrap 挂载接口，不要求新增 fd 挂载参数。工作进程打开文件后再次核对身份，写入前再次核对 SHA-256，再通过同一个句柄截断和写入。可写单文件拒绝已有多个硬链接的对象。进程结束后释放句柄并撤销本次 ACL。

新建文件和删除文件涉及目录命名空间权限：Runtime 的窄范围 broker 仅操作已批准的精确名称，不授予沙箱整个父目录的创建/删除权，也不在宿主读写内容。这是固定的授权路径，不是沙箱失败后的备用执行方式。新文件通过独占创建保留身份，工作进程启动失败会移除仍属于本次创建的空文件；不删除别人替换的对象。Windows 删除由沙箱内固定文件句柄执行，同一句柄校验 SHA-256 并提交删除，其间排除其他写入和替换。Linux 先原子移入私有临时目录，再在沙箱中核对身份和内容；失败时独占恢复原名，遇到并发新建则保留暂存对象并返回恢复位置，绝不覆盖新文件。Linux 临时目录必须与目标同一文件系统，跨文件系统返回 `workspace_atomic_delete_unavailable`，不改用不安全 unlink。补丁失败仍可能留下已创建的空目录，回执不得宣称所有副作用都已消除。后端能力会在命名空间变更前检查。

本地图片注入、`remember_source` / `remember_file` 和普通文件撤销、恢复统一接入上述通道。图片与来源备忘录在授权前解析实际目标，并把文件及目录身份带过审批和排队；外部文件使用单文件授权。撤销使用记录中的原始路径，拒绝被重定向的父目录，保留文件锁和版本冲突检查；Git 检查点撤销也只在该通道读取、修改所选路径，不通过宿主 Git 重扫工作区。Runtime 自有的不可变图片快照、Git 对象和事务日志仍由可信存储层管理，不是沙箱失败时的备用通道。尚无受检链接写入后端，因此涉及符号链接的恢复和任务副本创建在修改工作文件前明确拒绝；不在宿主跟随链接写入。

终端的默认工作区和额外目录授权均包含 `dev:ino` 身份；同名目录替换使原授权失效。原生宿主在修改 ACL 前固定目录及祖先，核对身份，再通过固定对象句柄授予和撤销 ACL，保留继承语义；单文件授权和删除后的清理同样使用固定对象。目录授权池的复用键包括这些身份，旧授权不能套用到同名的新目录。原生宿主使用不可变构建文件，更新后需重启本地 Runtime 才会加载新版本。

工作区 Git 和桌面 Git 入口仅执行可信绝对路径：显式 `CARDBUSH_GIT_PATH` 或宿主 PATH 中的绝对目录，排除工作区、当前目录内程序及相对 PATH 项；显式配置失效直接报 `git_unavailable`。这没有向模型终端默认开放 Git、Python、npm，也不会自动安装工具。Git 版本库自身的操作仍属于可信宿主功能，并不意味着所有 Git 操作都已进入命令沙箱。

Windows Runtime Worker 统一处理 `Path` / `PATH` 等环境变量别名，独立 Agent 保留宿主显式配置的 `CARDBUSH_GIT_PATH` 和 `CARDBUSH_RG_PATH`。这只修复可信程序定位，不给模型命令新增工具目录权限。

发现且当前启用的 Skill 的 `SKILL.md` 和 `references/` 可通过现有文件工具读取，不重复询问权限；该资源授权不覆盖脚本、整个安装目录、写入或终端。真实路径解析、目录/文件身份校验和受限进程仍保留；禁用、移除的 Skill 及指向包外的链接不获得此资源授权。`read_file` 遇到未变化的目录返回 `EISDIR`，实际路径替换仍返回授权变化错误。

`get_user_directories` 读取 Runtime 宿主账号的系统目录元数据。Windows 通过固定原生入口查询实际 home、desktop、documents（包括重定向目录），不会从 AppContainer 的私有 `USERPROFILE` 猜桌面。结果明确标记 `accessGranted: false`；后续移动和读写仍使用正常授权与文件通道。其他平台当前只返回可确认的 home，其余目录标记 unavailable。此固定入口不接受路径、不读取文件内容、不改变 ACL。

Browser Use 工具已安装不代表连接在线。`list_browsers` 在配置缺失、无效或桥不可达时返回明确状态与设置步骤；变更操作仍失败，不能借此自动启动其他浏览器或重放执行结果不明的操作。CLI 使用集成浏览器需要同机桌面桥，单独打开 CLI 不会创建它；连接恢复后再次查询即可，不缓存“永久离线”。

搜索直接执行沙箱内 rg：目录搜索只读授权该目录，单文件搜索只授权该文件，程序本身单独获得读取/执行权限。优先使用宿主 `CARDBUSH_RG_PATH` 的绝对路径；未配置时检查固定打包位置及宿主 PATH 中的绝对目录，拒绝工作区内程序、相对项和裸命令。显式配置失效直接报错，不另选程序。参数禁用外部配置及父级/全局 ignore 文件，保留输出、时间和资源限制；匹配与换行语义统一使用 rg。没有可信 rg 时返回 `workspace_search_unavailable`，由用户配置或授权安装，不自动安装，不回退到宿主遍历。

本轮 Windows 单文件 ACL、兄弟文件隔离、只读/写入、拒绝启动、路径替换、文件版本冲突、补丁回滚及 ACL 撤销均有实机回归。Linux 新增相同测试及挂载后身份校验，本机 WSL 未安装 bubblewrap，不能把 Windows 的通过计为 Linux 验收。macOS 尚无对应后端。直接 SSH 文件工具仍使用远端协议，不因此获得本机 AppContainer 隔离。

2026-10-24 补充文件访问通道回归：相关套件共 220 项，本机 215 项通过、5 项因 Linux 平台或未配置网络验收目标而跳过（包含更新目录身份字段后的权限断言定向复测）。其中 34 项覆盖 Git 工作区检查点，新增 `fileBoundaryRegression.test.mjs` 覆盖图片、来源备忘录、撤销、可信 Git、删除提交及目录授权替换；原生构建流程另有 23 项通过。Runtime、桌面主进程和界面 TypeScript 检查通过。Windows/Linux CI 已加入新增回归，但本次没有 Linux 实机结果。

2026-10-24 会话架构修复验收：从 `session-8700aa19-b503-49c8-a4d3-302d6ee1cd3b` 和 `session-095c0013-28b3-480d-b17a-381857b7b79e` 提取关键工具顺序与失败机制，在临时目录中做确定性回放；没有重放用户文件操作或保存原始消息。主回归与补充对抗测试、浏览器、原生构建、私有资源 RPC、Agent 启动/打包、CLI 确认和策略迁移测试去重后共 227 项通过，5 项因 Linux 平台或未配置网络验收目标跳过，0 失败。完整 Agent 构建、后续受影响包构建、主进程 TypeScript 检查及差异空白检查通过。

对抗测试另复现并修复了两种交错错误：并发大范围写入把小范围缓存 capability 带到移出工作区的文件上；取消排队后复用请求 ID 时，旧请求的异常处理删除新资源登记。还覆盖写入宿主崩溃、队列上限、排队取消、清理超时、Skill 包替换与外链、临时批准后恢复基础授权。核心新增用例位于 `sandboxArchitectureReplay.test.mjs`、`processAdmission.test.mjs`、`windowsSandboxScope.test.mjs` 和 `scripts/test-resource-coordination.mjs`。账号级缓存断言串行执行，避免把其他测试正常触发的失效误判成错误。

产品策略版本 5 在旧会话下一轮迁移一次，保留历史事实：UI 选择并确认即是有效答复，不重复索要确认短语；授权不能修复缺少后端/连接；使用浏览器先检查连接，桌面位置通过系统目录工具查询。`summary_for_user` 的最终显示信号及记忆关闭时传 `{}` 的逻辑保持不变，未恢复 `tool_summary`。

2026-10-24 审批与 CLI 退出修复：`session-0e9d7ef4-1840-434b-bb82-ff34078b7bf3` 中，后台脚本在等待用户审批时耗尽五分钟执行预算，取消了对应请求；CLI 仍显示旧提示，提交过期答案后异常退出，并把仍在运行的 Agent 任务显示为失败。修复后，脚本按多个审批等待区间的并集暂停执行计时，保留 CPU、内存、调用次数及具体工具的超时限制。CLI 在等待输入期间检查审批撤销和任务终态，提交前再核对；过期审批和已处理问题继续跟随原任务，丢失回执先核对记录，不自动重提。观察出错时保留终端与重连选项，只有确认的任务失败才显示 `Task failed`；重连保留事件游标、输出段和未决交互。Runtime 错误码经过 Worker、传输层和 HTTP 保持可辨认。

同次修复移除新模型目录中的通用预审批入口。旧会话的 `request_permission` 兼容处理返回 `granted: false`，不再弹出无法授权后续操作的空确认；实际文件和终端调用继续以具体参数申请权限。产品策略版本 6 在旧会话下一轮边界迁移，保留历史记录及 `summary_for_user` 行为。回放使用脱敏事件顺序和临时测试文件，不重跑原任务。CLI/终端、真实 CLI 进程、Runtime、策略迁移、IPC 和 HTTP 回归去重后 224 项通过，0 失败、0 跳过。已运行的共享 Runtime 不热替换执行中的代码；当前任务完成或由用户停止、最后一个 CLI 关闭后，新 Runtime 才加载此次运行时修复。

插件 hooks、stdio MCP、浏览器、Computer Use 和其他宿主辅助进程的接入仍需逐项处理，不能把“命令沙盒”宣传成所有工具都已隔离。

设计依据见 [调研与模块边界](EXECUTION_SANDBOX_PLAN.md)；Windows 使用 [Microsoft AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) 系统接口。
