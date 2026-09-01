# CardBush 真实 API 全功能与架构审查报告

- 审查日期：2026-08-31
- 被测仓库：`C:\Users\wfang\Desktop\cardbush-electron`
- 隔离测试项目：`C:\Users\wfang\Desktop\game`
- 真实模型：`dsfve`（`deepseek-v4-flash-vision-exp`，OpenAI Responses 兼容接口）
- 审查方式：真实 API 长链路运行、隔离项目读写、Python/Rust 差分验证、全仓发布门禁

## 1. 结论

本轮审查通过。真实 API Turn 明确完成，未发生 Provider 重试、无悬挂 Turn，API 缓存 Token 命中率为 **98.03%**，高于 95% 目标。

CardBush 的核心分层目前是成立的：Provider 事件由 Runtime 归一化，工具执行以结构化 Fact/Receipt 记录，终态不依赖文本猜测，Product Host 与 React 只消费产品协议。Responses 服务端状态不可用时，Provider 会自动回退到完整权威消息链，不会破坏会话正确性或 Cache Chain。

本轮同时确认了三个需要关注的事实：

1. `dsfve` 当前端点返回的 Response 不可用于 `previous_response_id` 连续调用，运行时已正确降级为无状态完整输入；这不是调用失败，但意味着本轮 98.03% 来自 Provider 的 Prompt Cache，而不是服务端 Response 状态复用。
2. 74 轮长链路累计输入 9,074,247 Token。缓存比例优秀，但绝对上下文量仍偏大，后续应继续压缩重复工具结果和长期事件投影。
3. Windows 下 `terminal_exec` 实际走系统默认 Shell，而工具契约没有明确告诉模型默认是 `cmd.exe`。本轮出现一次 PowerShell/Bash 风格命令误投给 `cmd.exe` 的情况，模型可以恢复，但这是需要单独治理的工具易用性问题。

## 2. 真实 API 运行结果

真实 API Runner 将 `game` 复制到系统临时目录后运行，排除了 `.git`、缓存、`target` 等目录。所有写入与修复都发生在临时副本中；检查确认原始 `C:\Users\wfang\Desktop\game` 在测试开始后没有文件变化。

| 指标 | 结果 |
|---|---:|
| Runtime 终态 | `completed / model_response_completed` |
| 模型轮数 | 74 |
| 总耗时 | 692.42 秒（约 11 分 32 秒） |
| Runtime 事件数 | 38,350 |
| Provider 重试 | 0 |
| 输入 Token | 9,074,247 |
| 缓存输入 Token | 8,895,232 |
| 未缓存输入 Token | 179,015 |
| 输出 Token | 65,388 |
| API 缓存命中率 | **98.0272%** |
| 工具调用 | 97 |
| 工具成功 | 87 |
| 工具失败 | 10（均有明确原因并被恢复） |

缓存命中率按 Provider 返回的 `cachedInputTokens / inputTokens` 计算：

```text
8,895,232 / 9,074,247 = 98.0272%
```

该指标直接反映真实 API Prompt Cache 命中情况。CardBush 内部 Cache Chain 的稳定前缀、观测事件和恢复语义由 Runtime 测试覆盖；两者不能混为同一个指标。

## 3. 功能覆盖

### 3.1 真实 API 已覆盖

- Responses 流式输出与 reasoning/assistant 分离。
- 74 轮同 Turn 工具闭环。
- Plan 更新与完成。
- 文件读取、写入、编辑和读后写版本保护。
- 命令执行、非零退出回执和错误恢复。
- 大工具结果归档与 `read_archived_tool_result` 回读。
- Python/Rust 双工具链构建与测试。
- 多随机种子的跨语言差分验证。
- 明确 terminal 状态、Usage 汇总和 Provider 重试统计。
- Response Chain 不可用时的自动兼容降级。

### 3.2 全仓自动化门禁已覆盖

`npm run test:all` 全部通过，包含：

- Protocol、Runtime、Provider、Product Agent、Product Host。
- Runtime 115/115、Product Agent 2/2、Product Host 13/13。
- Provider 14/14、MCP Client 10/10、Apps MCP 7/7、Electron Transport 4/4。
- 权限、Execution Fact、Receipt、停止与恢复、Goal/A2A、工具历史投影。
- Electron Utility Process 与 Product Host 启动链。
- 官方 Chrome MCP 29 个工具装载。
- 文件/文件夹附件契约、消息编辑和多媒体消息契约。
- TypeScript 类型检查、Vite 生产构建、发布清理。
- 内置 ripgrep 15.2.0 可用性。

### 3.3 本轮未做破坏性实测的边界

为避免操作用户真实桌面、浏览器账号和外部系统，本轮没有让 Agent 实际控制鼠标、Chrome 登录态或向外部服务写数据。Computer Use、Chrome MCP、Electron UI 的协议、装载和自动化测试已通过，但仍应保留一次人工安装包验收，不能把本报告等同于真实桌面副作用测试。

## 4. 工具失败归因

10 次失败均被 Runtime 记录为结构化结果，没有被当成成功，也没有导致 Turn 卡死。

| 类型 | 数量 | 结论 |
|---|---:|---|
| `terminal_exec` 非零退出 | 9 | 包含基线 Rust 集成测试失败、负向/边界校验、`python` 不存在后改用 `py`、Windows Shell 语义不匹配；模型均恢复 |
| `write_file` 版本保护拒绝 | 1 | 文件当前版本未先观察，Runtime 要求 `read_file` 后重试；这是防止覆盖并发修改的正确 Guard |

需要修复的不是“隐藏失败”，而是 Windows Shell 契约不够明确。建议后续让 `terminal_exec` 显式声明当前 Shell，或提供受控的 `cmd`/`powershell` 选择；在完成该协议调整前，不应静默改写模型命令。

## 5. 本轮代码修复与架构强化

当前提交包含此前实际复现问题的完整修复，并已纳入全仓验证：

### 5.1 Responses 连续轮次

- 协议增加 Turn 内临时 `providerState`，支持 `previous_response_id` 与输入偏移。
- Provider 仅在服务端确认 Response 可存储时继续状态链。
- 遇到不兼容或 `response_not_stored` 时自动停用状态链，回退到完整消息输入。
- Provider 状态不写入恢复 Checkpoint；恢复始终从权威消息历史重建，避免旧状态污染。
- 工具回合后继续保留正确的消息偏移和 Response ID。

真实 `dsfve` 运行验证了降级路径：仅启动时记录一次 `provider_response_chain_disabled / response_not_stored`，后续完整运行 74 轮，Provider 重试为 0。

### 5.2 权限队列与工具运行状态

- `permission_requested` 会把对应工具投影为 `awaiting_permission`，不再长期显示“运行中”。
- 多个权限请求按队列保留第一个可见请求，回复/取消后自动切换到下一项。
- Turn 终止后清理遗留交互状态。
- UI 区分排队、等待、等待授权、运行、取消和终态，不再把所有非完成状态统一显示为运行中。

### 5.3 文件夹附件

- Electron 附件检查同时识别文件与文件夹。
- Composer 与消息历史保留 `folder` 类型，不再把项目目录渲染成普通文件。
- 文件夹使用独立图标和文案，点击后调用系统打开目录；普通文件继续走只读预览。

## 6. CardBush 架构评价

### 6.1 正确的边界

- `bush-protocol` 是 Runtime、Electron 和产品层的唯一稳定事实契约。
- Provider 私有事件不会直接泄漏给 React。
- Runtime 掌握 Agent Loop、工具执行、重试、权限、终态和恢复；UI 不从自然语言猜测状态。
- 工具结果带 Execution Fact/Receipt，文件写入受观察版本约束。
- Provider continuation 是可丢弃的性能状态，不是会话真相，恢复边界设计正确。
- Product Host 作为内嵌 Runtime 的产品适配层工作，不依赖旧的前后端 HTTP Loop。

### 6.2 性能与可维护性风险

| 级别 | 风险 | 证据 | 建议 |
|---|---|---|---|
| 中 | 长 Turn 绝对上下文量偏大 | 74 轮累计输入 907 万 Token、事件 3.8 万 | 对工具大结果继续做结构化摘要与归档，建立每轮增量/稳定前缀指标 |
| 中 | `dsfve` 无 Response 状态复用 | 服务端返回 `response_not_stored` | 保留当前自动降级；按 Provider capability 显式展示，不要反复探测 |
| 中 | Windows Shell 契约含糊 | 出现 Shell 语法错投与 exit 255 | 在工具 Schema 中显式声明 Shell，补 Windows 双 Shell 测试 |
| 低 | 真实 API Runner 指标维度不足 | 当前主要汇总 Token、事件与工具结果 | 后续增加逐轮 Cache、上下文长度、首 Token、工具等待时间分位数 |
| 低 | GUI/外部副作用仍需人工验收 | 自动测试不操作真实鼠标和登录账号 | 对安装包执行冷启动、权限、Chrome 复用、ESC 中断专项验收 |

## 7. `game` 测试项目的架构发现

`game` 是 Python/Rust 双实现的 CardForge/War 引擎。真实 Agent 完成了逐模块审查和固定 Seed 差分测试。

### 7.1 通过项

- Python 演示：18/18。
- Rust 库测试：39/39。
- 临时副本修复 Rust 集成测试后：44/44。
- 固定 Seed `[5, 6, 42, 123, 999]`：合计 2,924 条战斗转录，Python/Rust 逐行差异为 0。
- 边界检查：11/11。
- 安全写入、回读和 SHA-256 校验一致。

临时副本中的 Rust 测试修复没有复制回原始 `game` 项目，因为本轮目标是审查 CardBush Runtime，不应擅自修改测试项目。

### 7.2 发现的问题

| 级别 | 问题 | 影响 |
|---|---|---|
| 中 | Python Card 序列化为 `ACE/CLUBS`，Rust 为 `Ace/Clubs` | 两端存档不能直接互载 |
| 中 | Rust `CustomEffect::to_action()` 会 panic | Python 支持的效果在 Rust 可能导致进程崩溃 |
| 中 | EventBus 历史上限 512 | 长对局通过 history 回放时会丢早期事件 |
| 低 | Rust `run()` 使用 `unsafe` 裸指针规避借用冲突 | 增加维护和演进风险 |
| 低 | Rust WarRules 忽略玩家名参数 | 两端公共接口不完全一致 |
| 低 | Python/Rust `data` 值类型不同 | 跨语言协议需要额外规范 |

这些问题没有改变本轮固定 Seed 的游戏结果，但前三项会影响跨语言存档、扩展效果和完整审计回放，建议在 `game` 项目单独修复。

## 8. 最终判断

- Cache 目标：**通过，98.03% > 95%**。
- 真实 API 稳定性：**通过，74 轮完成，Provider 重试 0，终态明确**。
- Runtime 工具闭环：**通过，失败均有事实记录并可恢复**。
- 架构边界：**通过，未发现重新回退到 HTTP 前后端 Loop 或由 UI 猜测 Runtime 状态的情况**。
- 发布门禁：**通过，`npm run test:all`、类型检查和生产构建全部成功**。
- 遗留重点：绝对 Token/事件规模、Windows Shell 契约、安装包真实桌面专项验收。

本报告不包含任何 Provider 密钥；真实配置仅在本机读取，没有写入仓库或测试产物。

## 9. 后续通用优化（2026-09-01）

根据审查结论完成以下通用改进；未修改 Append-only 事实链，也未修改 `game` 项目：

- Provider capability 改为 `unknown / supported / unsupported` 能力矩阵，按适配器配置修订、模型和能力隔离。
- 能力观测持久化到 Runtime 状态目录，默认 24 小时失效后重新协商；配置、端点、凭据或模型变化都会进入新的能力作用域。
- 能力处理不包含服务商名称或特定模型分支；当前 Responses continuation 只是该通用矩阵中的第一项能力。
- `terminal_exec` 在协议中显式选择 `powershell / cmd / posix`，Runtime 不再依赖 Node 隐式 Shell。
- 实际 Shell 与可执行文件写入 Tool Result 和 Execution Fact；PowerShell Harness 会保留原生命令退出码。
- 新增打包产物冒烟：真正构建并隐藏启动 `CardBush.exe`，无 Provider 凭据验证 Renderer、Utility Runtime、Product Host、Apps MCP、Chrome MCP、ripgrep 和干净退出。

首次真实打包冒烟结果：

| 指标 | 结果 |
|---|---:|
| 打包应用总自检耗时 | 1,941 ms |
| Runtime 就绪耗时 | 1,816 ms |
| Renderer | 通过 |
| Runtime capability command | 通过 |
| Product Host | 通过 |
| Apps MCP / Chrome MCP / ripgrep 资源 | 全部存在 |
| 干净关闭 | 通过 |
