# CardBush Runtime / MCP 优化与真实 API 数据分析

- 日期：2026-09-01（Asia/Shanghai）
- 被测仓库：`C:\Users\wfang\Desktop\cardbush-electron`
- 隔离测试项目：`C:\Users\wfang\Desktop\game`
- 模型配置来源：BushServer 本地模型配置
- 真实模型：`deepseek-v4-flash-vision-exp`
- API 形态：OpenAI Responses 兼容接口

## 1. 结论

本轮优化和真实 API 验收通过。

1. 复杂场景明确完成，共 36 个模型轮次、50 次工具调用、38,190 条 Runtime 事件，Provider 重试为 0。
2. 复杂场景 Prompt Cache 命中率为 **95.9886%**，达到 95% 目标。
3. 两次真实 API 合计 57 次工具调用，工具结果一致性扫描为 **0 条违例**；没有成功/失败、Error、Execution Fact、Receipt 或 terminal 互相矛盾的记录。
4. 定向错误恢复场景证明：`edit_file` 的预期失败会以稳定的 `edit_old_text_not_found / tool` 返回，模型能够继续执行并完成 Turn，文件哈希未变化。
5. 标准 MCP 结果不再被 CardBush 擅自解释成业务成功；只有显式受信任的 CardBush 内置扩展可以提交权威 Receipt、Execution Fact、Artifact、Workspace Change 和 Guidance。
6. Append-only 会话事实链没有被删除、压缩或改写。本轮只优化协议约束、错误分类、终态投射和读取路径。
7. `game` 原项目没有被修改；Runner 只操作系统临时目录中的副本。

## 2. 本轮架构优化

### 2.1 统一 Tool Result / Execution Fact 契约

`bush.tool_result.v1` 现在机械校验：

- 成功结果不能携带 Error。
- 失败结果必须携带结构化 Error。
- 成功结果不能包含执行失败或语义失败的 Fact。
- `verified` 必须显式对应 `semantic_success=true`。
- 语义成功不能建立在执行失败之上，也不能同时携带错误码。
- `completed/succeeded` 必须有真实执行成功事实。
- `failed` 必须明确记录语义失败。

保留了两个不同维度：

- `execution_success`：动作或进程是否真实执行。
- `semantic_success`：执行结果是否实现工具目标。

例如命令成功启动但退出码非零时，合法事实是 `execution_success=true`、`semantic_success=false`。这类事实不能被简化为单个布尔值。

### 2.2 MCP 信任边界

标准第三方 MCP 按 MCP `CallToolResult` 处理：

- `isError=false` 只证明 MCP 调用未返回错误。
- CardBush 本地投射为 `execution_success=true`、`semantic_success=null`、`verification_state=unverified`。
- 标准 MCP 不能注入 CardBush 私有的 Receipt、Fact、Artifact、Workspace Change、Guidance 或 Action Manifest。

只有配置了 `acceptCardbushExtensions=true` 的内置 `cardbush_apps` 服务可以返回完整 CardBush 扩展结果。外部服务即使伪造相同字段，也只会被当作普通 MCP 内容。

### 2.3 结构化错误分类

Error 统一分为：

- `tool`
- `protocol`
- `transport`
- `permission`
- `cancelled`
- `runtime`

具体规则：

- 工具处理器拒绝、文件不存在、命令非零退出：`tool`。
- 参数 JSON/Schema、Tool Result 契约不合法：`protocol`。
- MCP 连接或传输中断：`transport`。
- 权限拒绝或权限请求失败：`permission`。
- 明确取消：`cancelled`。
- Runtime 内部编排异常：`runtime`。

Node 文件系统错误码（如 `ENOENT`）会保留，不再统一折叠成 `tool_admission_exception`。`edit_file` 也增加了稳定错误码：

- `edit_old_text_not_found`
- `edit_old_text_ambiguous`
- `workspace_revision_not_observed`
- `workspace_resource_busy`

### 2.4 GUI 与 Runtime 终态投射

- `tool_completed/tool_failed` 到达后，GUI 立即记录 terminal lifecycle。
- 工具详情的异步加载只是 enrichment，不再阻塞终态。
- enrichment 设置 5 秒边界；失败只记录结构化警告，不能把工具永久留在“运行中”。
- `tool_failed` 事件直接携带错误 kind/code/message/details，GUI 不必等待第二次查询才知道失败原因。
- UI 内部只使用 canonical 状态：`queued/running/awaiting_permission/completed/failed/cancelled`。
- Subagent 只使用 `running/completed/failed/stopped`；历史同义词仅在单一边界解码，不在组件内做字符串排列组合。

### 2.5 去除硬编码语义与工具偏好

- 删除产品 Prompt 中 Chrome 与 Computer Use 的优先级/竞争指导，让模型依据工具定义和当前事实自主选择。
- 用户选择能力由 Runtime capability 与产品设置决定，不再用常量关闭。
- 工作区、Subagent、权限和 not-found 判断不再依赖错误文案正则。
- Computer Use 的观察类操作可记录 verified；桌面变更动作只记录 attempted，不再无条件声称已验证。

## 3. 真实 API 场景一：复杂跨语言工程验证

任务要求模型在 `game` 临时副本中审查 Python/Rust 两套 War/CardForge 实现，补充跨语言确定性验证，执行现有测试和固定 seed 差分，并在真实失败后恢复。

| 指标 | 数值 |
|---|---:|
| Runtime 终态 | `completed / model_response_completed` |
| 模型轮次 | 36 |
| 有工具调用的最大轮次 | 35 |
| 总耗时 | 526,808 ms（约 8 分 47 秒） |
| Runtime 事件 | 38,190 |
| Provider 重试 | 0 |
| 输入 Token | 2,894,076 |
| 缓存输入 Token | 2,777,984 |
| 未缓存输入 Token | 116,092 |
| 输出 Token | 50,454 |
| Prompt Cache 命中率 | **95.9886%** |
| 工具调用 | 50 |
| 工具成功 | 46 |
| 工具失败 | 4 |
| Fact | 50 |
| Fact 一致性违例 | **0** |
| 工具耗时 P50 | 3 ms |
| 工具耗时 P95 | 3,030 ms |
| 工具最大耗时 | 15,579 ms |

### 3.1 事件分布

| 事件 | 数量 |
|---|---:|
| reasoning delta | 35,147 |
| assistant delta | 2,716 |
| cache chain observation | 36 |
| tool queued/running | 50 / 50 |
| tool completed/failed | 46 / 4 |
| turn terminal | 1 |

事件量主要来自细粒度 reasoning delta。Append-only 设计按要求保留，因此这里不通过删除历史降低事件数；后续若优化，应只调整产品投射、分页和索引，而不是改写权威事实链。

### 3.2 工具分布

| 工具 | 数量 |
|---|---:|
| `read_file` | 20 |
| `terminal_exec` | 20 |
| `update_task_plan` | 4 |
| `write_file` | 4 |
| `edit_file` | 2 |

4 次失败均有明确 Error 和失败 Fact：

- 3 次 `terminal_exit_nonzero`：真实命令非零退出，模型随后恢复。
- 1 次旧文本不匹配：本轮测试发现它原先被归为 `tool_execution_exception/runtime`；已修复为稳定的 `edit_old_text_not_found/tool`。

50 个 Fact 中 46 个 verified/semantic true，4 个 failed/semantic false，没有未知或矛盾状态。

## 4. 真实 API 场景二：结构化错误恢复

第二个场景主动要求模型触发一次不存在的 `old_text` 编辑，再验证工作区仍可访问且没有文件变化。

| 指标 | 数值 |
|---|---:|
| Runtime 终态 | `completed / model_response_completed` |
| 模型轮次 | 8 |
| 总耗时 | 59,965 ms |
| Runtime 事件 | 4,924 |
| Provider 重试 | 0 |
| 输入 Token | 78,089 |
| 缓存输入 Token | 66,816 |
| 输出 Token | 6,082 |
| Prompt Cache 命中率 | 85.5639% |
| 工具调用 | 7 |
| 工具失败 | 2 |
| Fact 一致性违例 | **0** |

关键回归结果：

- `edit_file` 返回 `kind=tool`、`code=edit_old_text_not_found`。
- 模型正确读取错误并继续执行只读命令。
- 被测文件前后 SHA-256 一致，预期失败没有产生 Workspace Change。
- Turn 最终明确完成，没有停在“运行中”。

另一次失败来自任务要求读取实际不存在的根 `README.md`。测试发现原始实现把 `ENOENT` 包装成 Runtime admission 异常；本轮已修复为保留 `ENOENT/tool`，并增加自动化回归测试。

短场景命中率低于 95% 是正常现象：它只有 8 轮，稳定前缀尚未像长场景那样被多次复用。因此 95% 目标以复杂长场景为验收依据，不把短任务单独当作 Cache Chain 退化。

## 5. 合并数据

| 指标 | 两次合计 |
|---|---:|
| 总耗时 | 586,773 ms |
| 输入 Token | 2,972,165 |
| 缓存输入 Token | 2,844,800 |
| 未缓存输入 Token | 127,365 |
| 输出 Token | 56,536 |
| 加权 Prompt Cache 命中率 | **95.7147%** |
| Runtime 事件 | 43,114 |
| 工具调用 | 57 |
| 工具失败 | 6 |
| 一致性违例 | **0** |

缓存命中率按 Provider 返回的 `cachedInputTokens / inputTokens` 计算。服务端本次仍明确报告 `response_not_stored`，所以 Response continuation 被通用 capability 机制标记为 unsupported，并降级到完整权威消息链。本报告的命中率来自 API Prompt Cache，不等同于 `previous_response_id` 状态复用，也不等同于 CardBush 的 Cache Chain 结构观测。

## 6. 自动化与发布门禁

最终执行 `npm run test:all` 全绿：

- Protocol：21/21。
- Runtime：122/122。
- MCP Client：13/13。
- Apps MCP：9/9。
- Electron Runtime Transport：4/4。
- Product Agent、Product Host、Provider 测试通过。
- Electron Utility Process 联调通过。
- GUI 工具历史、终态、Subagent、权限、启动链等契约通过。
- bundled ripgrep 15.2.0 验证通过。
- TypeScript renderer/node 类型检查通过。
- Vite 生产构建通过（2,230 modules）。
- release cleanup 生产包契约通过。
- `git diff --check` 通过，仅有仓库既有 CRLF 转换提示。

门禁过程中还清理了两类过期测试：

1. UI 契约仍要求 `result_ready/completed` 等旧同义词分类器，已改为验证 canonical 状态并禁止旧排列组合。
2. App Host 契约仍要求存在 Chrome/Computer Use 优先级 Prompt，已改为明确禁止该硬编码指导。

同时发现单独执行 Runtime workspace 测试时，如果 Protocol `dist` 没有先重建，会读取陈旧协议。正式发布链会先执行 `build:runtime`，所以最终门禁不受影响；后续可把单包测试脚本也显式绑定 Protocol build，减少开发误判。

## 7. 剩余风险与建议

### 中：Append-only 长任务的读取与投射成本

复杂场景 38,190 条事件中，reasoning delta 占 92% 以上。按要求不改变 append-only 权威事实链。建议只做：

- 事件索引与游标分页。
- GUI 按需投射和虚拟列表。
- terminal/fact 索引独立读取。
- 大输出继续归档并使用 locator 回读。

### 低：标准 MCP 的语义仍然未知

这是有意设计，不是缺陷。标准 MCP 没有 CardBush Execution Fact 时，Runtime 只能报告调用成功、语义未知。需要业务级 verified 时，应由本地受信任适配器或后续独立验证工具生成事实，不能从文本猜测。

### 低：短 Turn 的 Prompt Cache 波动

短任务固定成本占比高，不能保证每次都超过 95%。应持续观察：

- 长任务加权命中率。
- 每轮未缓存 Token。
- 稳定前缀断裂原因。
- Provider binding/tool schema 变化次数。

### 低：真实桌面与外部账号副作用未纳入本轮

本轮没有操作用户真实鼠标、Chrome 登录态或外部服务写入。Computer Use、Chrome MCP 和 GUI 已由自动化契约覆盖，但正式安装包仍应保留人工的真实桌面专项验收。

## 8. 原始报告位置

- 复杂场景：`C:\Users\wfang\AppData\Local\Temp\cardbush-ts-live-2026-08-31T18-12-49-744Z\report.json`
- 错误恢复：`C:\Users\wfang\AppData\Local\Temp\cardbush-ts-live-2026-08-31T18-27-22-083Z\report.json`

这些报告位于系统临时目录，不含 API Key。BushServer 凭据只在进程内读取，没有写入仓库、stdout 或本报告。
