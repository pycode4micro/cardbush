# 命令执行沙盒

本轮实现了共用终端的操作系统隔离入口，并将工作区路径授权、终端会话管理、平台隔离和资源治理分开。桌面端与独立 Agent 的 `terminal_exec` 使用相同实现。项目仍在原来的目录中，不分区、不创建虚拟磁盘、不复制项目。

**目前为显式启用的命令沙盒，默认 `off`。它不是整个 CardBush 的安全边界，也尚未达到 Codex 的全部防护覆盖。** Windows 已完成真实进程测试；Linux 接入了 bubblewrap，并提供了实机测试，但本次 Windows 开发环境没有 Linux/WSL，尚未完成 Linux 实机验收。macOS 暂不支持，强制开启时拒绝执行。

## 启用

独立 Agent 启动时增加：

```sh
node dist-electron/agentServiceCli.mjs \
  --data-dir /srv/cardbush/agent-a \
  --sandbox required --sandbox-network disabled
```

桌面端和 Agent 服务也可以在启动环境中配置以下变量。它们由实际运行 Runtime 的宿主读取，不属于模型参数或会话设置；修改后需重启宿主。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `CARDBUSH_EXECUTION_SANDBOX` | `off` | `required` 强制隔离；初始化失败、后端不支持或缺失时拒绝命令，不重试为普通进程 |
| `CARDBUSH_SANDBOX_NETWORK` | `disabled` | `disabled` 禁止命令联网；`enabled` 允许后端支持的联网，不提供域名白名单 |
| `CARDBUSH_SANDBOX_READ_ROOTS` | `[]` | JSON 格式的绝对目录列表，额外可读、可执行的工具或参考目录 |
| `CARDBUSH_SANDBOX_WRITE_ROOTS` | `[]` | JSON 格式的绝对目录列表，额外可写目录 |

会话当前工作区是默认可写范围，临时 HOME、配置和缓存使用每次命令独立的普通临时目录。目录会解析真实路径；磁盘根目录、Windows 网络共享、文件路径及包含沙盒管理日志的宽泛目录不能作为授权根。审批一个范围外的 `cwd` 不会自动扩大沙盒；`all_free`、工具参数、`taskRoots`、`userRoots` 也不能关闭或扩大宿主的命令隔离。

Windows 下安装在用户目录中的 PowerShell、Node、Python 等运行时，可能需要将其**具体安装目录**加入只读列表。例如 PowerShell 可执行文件位于 `C:\Tools\PowerShell\pwsh.exe`，则配置 `CARDBUSH_SANDBOX_READ_ROOTS=["C:\\Tools\\PowerShell"]`。不要为了运行一个工具而放开整个用户目录。命令不会继承宿主服务令牌、模型密钥、代理凭据、`NODE_OPTIONS`、`LD_PRELOAD` 或用户启动配置；依赖这些配置的工作流需要单独设计受控授权。

## 各环境的实际范围

- **Windows**：每次命令使用一次性 AppContainer 身份。对指定目录设置该身份的临时 ACL；子进程继承隔离。无网络能力时，Windows 阻止 socket 联网。命令挂起创建，在既有 Job Objects 资源约束就绪后才运行。不需要管理员初始化或关闭智能应用控制。此实现采用 AppContainer，和 Codex 官方文档中的专用低权限用户方案不同。
- **Linux**：执行主机需要 `/usr/bin/bwrap`，内核及部署环境允许用户命名空间。命令运行在独立用户、进程、IPC、UTS 命名空间内；禁止网络时使用独立网络命名空间。系统工具和必要配置只读挂载，工作区直接绑定原路径，不挂载宿主 `/`、真实用户 HOME 或 `/run`。当前没有额外 seccomp 系统调用过滤，不能宣称与 Codex Linux 沙盒等价。
- **普通 SSH 项目**：客户端无法限制服务器上的 shell。启用 `required` 后，在没有远端沙盒能力握手的情况下拒绝 SSH `terminal_exec` 和 `terminal_write`，保留查询、停止等管理操作。可以连接由管理员开启沙盒的独立 CardBush Agent，在服务器上执行。
- **独立云 Agent**：HTTP/SSH 只是连接方式，隔离由服务器 Runtime 实施。桌面设置或子代理参数不能关闭服务器的宿主策略；远程 Agent 也不继承本机目录授权。

终端返回和 `terminal_list` 中的 `sandbox` 字段表示该终端要求的隔离后端及网络策略；未要求隔离时为 `null`。它与资源限制分开：Windows 继续使用原来的内存、CPU、进程数和进程树预算；Linux 不能据此宣称具有 Windows Job Object 同等的内核资源配额。

## 生命周期与构建

Windows ACL 修改按执行账号串行处理，覆盖同时使用同一项目及嵌套项目的情况。命令退出或被停止后，仅清理本次身份的权限，不恢复可能覆盖其他会话更改的旧 ACL。杀死宿主导致其 `finally` 未执行时，Runtime 会启动清理入口。清理失败保留 `cardbush-sandbox-*/policy.json` 并返回错误。

机器断电或 Runtime 与原生宿主同时被强制杀死的自动恢复尚未实现。此时的一次性身份不会被后续命令复用，但可能遗留 ACL 和配置。确认对应任务已结束后，可由维护人员使用同版本原生宿主的 `--sandbox-cleanup <policy.json>` 清理；不要在运行期间删除日志，也不要直接恢复整棵项目的 ACL。

原生构建先编译为不可变版本文件，再运行 `--capabilities` 检查；新文件不能启动或版本不兼容时，保留原来的发布清单。签名和 Windows 应用控制仍是发布要求；一次开发机测试通过不代表文件已获得发行签名或其他机器必定允许执行。旧版宿主不能用于强制沙盒，能力检查会拒绝。

## 验证与待办

在仓库根目录运行：

```sh
npm run build --workspace @cardbush/bush-runtime
node --test packages/bush-runtime/test/commandSandboxPolicy.test.mjs packages/bush-runtime/test/executionSandbox.test.mjs
```

Windows 原生测试覆盖实际文件读写、只读目录、junction、子进程、socket、宿主环境变量隔离、cmd/PowerShell、并发嵌套根、停止清理和 ACL 恢复。后端缺失的测试验证不执行命令且释放资源额度。Linux 测试在 Linux 主机上真实运行 bubblewrap，缺失后端不会静默跳过或算作通过。

2026-09-23 开发过程中，一轮合并回归的测试程序被 Windows 应用控制拦截，Code Integrity 事件 3077 和原生错误 4551 指向未满足签名要求，该轮 11 项未完成。提交前复核的 76 项本机回归全部通过，覆盖 Windows 沙盒、资源治理、审批、终端和 SSH；从 Runtime 包目录启动沙盒测试也通过。Linux 实机项在 Windows 上跳过，仍不能记为 Linux 验收通过。整个过程未关闭系统防护或更换启动方式绕过拦截；开发测试通过也不代表发行签名问题已解决。CI 已增加 Windows/Linux 真实沙盒测试，Linux 构建安装 bubblewrap。

默认启用前仍需完成：Linux 实机验收、发行签名、崩溃恢复、受保护配置和项目内已有硬链接的安全策略、Windows 允许联网模式、更多语言运行时兼容性及大型项目 ACL 更新开销测量。Windows 系统已有的 AppContainer 公共资源权限仍可能可读；项目内的敏感文件也不会被此实现自动识别或隐藏。

文件工具继续使用原有路径审批，不受本次子进程沙盒直接控制。插件 hooks、stdio MCP、浏览器、Computer Use 和宿主辅助进程的接入仍需逐项处理，不能把“命令沙盒”宣传成所有工具都已隔离。

设计依据见 [调研与模块边界](EXECUTION_SANDBOX_PLAN.md)；Windows 使用 [Microsoft AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) 系统接口。
