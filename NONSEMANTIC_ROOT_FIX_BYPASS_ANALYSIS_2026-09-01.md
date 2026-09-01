# CardBush 非语义分类器根因修复旁路验证报告

- 日期：2026-09-01（Asia/Shanghai）
- 旁路工作树：`C:\Users\wfang\Desktop\cardbush-nonsemantic-trial`
- 旁路分支：`codex/nonsemantic-root-fix`
- 基线提交：`61ba538 chore: snapshot nonsemantic trial baseline`
- 原产品工作树：`C:\Users\wfang\Desktop\cardbush-electron`（验证期间未修改）
- 真实 API 模型：`deepseek-v4-flash-vision-exp`
- 测试项目：`C:\Users\wfang\Desktop\game` 的系统临时副本

## 1. 结论

本轮旁路修复通过回放、完整自动化和真实 API 长任务三层验证，建议并入产品工作树。

修复没有增加服务商、模型、工具名、语言或错误文案特判。状态只来自协议字段、Schema、HTTP 状态、Runtime Event、Tool Result 和 Execution Fact。真实 API 长任务最终明确完成，Prompt Cache 命中率为 **97.6890%**，Provider 重试为 **0**，76 次工具执行的事实一致性违例为 **0**。

这不是兼容层：旧状态别名、错误消息正则和隐藏重试被删除；不符合当前协议的数据直接作为协议错误暴露。内部协议生产者与消费者同步升级，避免继续维护状态排列组合。

## 2. 根因与修复

### 2.1 IPC 错误缺少机器可判定的类别

原实现会读取异常文本来判断网络恢复，例如把包含特定英文短语的错误当成传输故障。相同故障若由不同平台、SDK 或本地化文案产生，就会得到不同状态。

根因修复：

- `RuntimeProtocolError` 强制携带 `kind=protocol|transport|runtime|cancelled`。
- Electron bridge 拒绝统一投射为 `transport`；同版本但内容不合法的帧投射为 `protocol`。
- Host Controller 与 Worker 在错误产生处赋予类别，不在 GUI 端猜测。
- GUI 连接恢复只读取 `RuntimeRemoteError.fact.kind`。

### 2.2 Provider 能力未知时存在隐式兼容重试

原实现会根据错误文本判断 continuation 是否兼容，并在失败后偷偷改为完整输入再次请求。这会隐藏真实失败，制造双请求，还把服务商文案当成协议。

根因修复：

- continuation 只有在能力存储明确记录为 `supported` 时启用。
- 能力为 `unknown/unsupported` 时从一开始就发送完整权威输入，只请求一次。
- 已确认支持后若收到 HTTP 400，直接返回事实，不做隐藏的第二请求。
- 只有 SDK 提供结构化 HTTP 状态时才按状态决定 retryable；普通本地异常不重试。
- streamed `response.failed/error` 没有结构化 retryability 时保守设为不可重试。

真实 API 观察到 `response_not_stored` 后，能力被机械记录为 unsupported，后续请求保持 stateless；全程 Provider 重试为 0。

### 2.3 Runtime、持久层和 UI 使用多套状态词

原实现同时接受 `complete/completed/succeeded/success/done`、`cancelled/canceled/stopped`、`submitted/running` 等别名，并在多处重复解码。一个状态可能因进入不同组件而改变含义。

根因修复：

- Tool 生命周期只接受 `queued/running/awaiting_permission/completed/failed/cancelled`。
- Assistant 持久状态保持 Runtime 的 `completed`，不再转换成 UI 私有 `complete`。
- Subagent 直接使用协议的 `running/completed/failed/stopped`；异步 dispatch 不再伪造任务状态 `submitted`。
- `submitted` 仅保留为 Execution Fact 的执行回执状态，与 Subagent 任务生命周期明确分离。
- 删除按旧状态猜测 Session 是否仍在运行的函数；活动 Turn 使用显式 live Turn ID，已提交快照按协议就是终态。
- 非法状态直接失败，不再默默兼容。

### 2.4 UI 从输出文本重建执行事实

原工具卡片和 Plan 验证面板会解析工具名、输出对象别名及 `/fail|false|missing/` 等文本来判断成功或失败。这会让展示层成为第二套 Runtime。

根因修复：

- 工具失败只由 canonical `execution.state === 'failed'` 决定。
- Plan 验证面板仅在 Execution Fact 明确声明 `plan_verification` 时启用。
- 验证状态只读取 `verification_state`、`semantic_success` 和结构化 assertion `{label, passed, summary?}`。
- A2A 错误不再根据 `404/not found` 文案被静默隐藏。

文件差异、Artifact 和 Markdown 等纯展示增强仍可解析内容；它们不能改变 Turn、Tool、权限、验证或恢复状态，因此不属于事实分类器。

## 3. 回放验证

新增 `test:nonsemantic-root` 门禁，直接解码并回放 `single-turn-stream.v1.json`：

- 回放 9 条 `bush.runtime_event.v1` 事件。
- 校验 sequence 严格递增。
- reasoning 与 assistant 保持独立通道。
- terminal 必须来自明确 `turn_terminal/completed`。
- 使用 reasoning 游标续播时，下一事件必须是 assistant start。
- 静态检查禁止目标兼容分类器重新出现。

结果：`nonsemantic root contract and replay passed (9 events)`。

## 4. 完整自动化门禁

从旁路工作树根目录执行 `npm run test:all`，退出码为 0：

| 模块 | 结果 |
|---|---:|
| Protocol | 21/21 |
| Runtime | 122/122 |
| Product Agent | 2/2 |
| Product Host | 13/13 |
| Provider | 18/18 |
| MCP Client | 13/13 |
| Apps MCP | 9/9 |
| Electron Runtime Transport | 6/6 |

同时通过：

- Electron Utility Process 真实启动与 IPC。
- Runtime 内置工具与 MCP 边界。
- Session、停止、历史工具、Subagent、Goal/A2A、连接恢复等前端契约。
- bundled ripgrep 15.2.0。
- renderer/node TypeScript 类型检查。
- Vite 生产构建（2,229 modules）。
- release cleanup 生产包契约。
- `git diff --check`（仅有仓库既有的 CRLF 提示）。

## 5. 真实 API 长任务

Runner 从 BushServer 本地模型配置读取凭据，只操作 `game` 的临时副本：

- 原项目：`C:\Users\wfang\Desktop\game`
- 临时副本：`C:\Users\wfang\AppData\Local\Temp\cardbush-ts-live-2026-08-31T22-38-41-257Z\game`
- 原始报告：`C:\Users\wfang\AppData\Local\Temp\cardbush-ts-live-2026-08-31T22-38-41-257Z\report.json`

| 指标 | 旁路修复结果 |
|---|---:|
| Runtime 终态 | `completed / model_response_completed` |
| 模型轮次 | 55 |
| 总耗时 | 714,101 ms（约 11 分 54 秒） |
| Runtime 事件 | 46,772 |
| Provider 重试 | **0** |
| 输入 Token | 7,937,809 |
| 缓存输入 Token | 7,754,368 |
| 未缓存输入 Token | 183,441 |
| 输出 Token | 69,813 |
| Prompt Cache 命中率 | **97.6890%** |
| 工具调用 | 76 |
| 工具成功 / 失败 | 67 / 9 |
| Execution Fact | 76 |
| 一致性违例 | **0** |
| 工具耗时 P50 / P95 / Max | 4 / 2,076 / 11,843 ms |

事件中 reasoning delta 为 44,023 条、assistant delta 为 2,252 条。按要求保留 append-only 权威链，没有通过删减事件来优化指标。

### 5.1 失败工具的结构化归因

9 次工具失败全部带有 `kind=tool` 和稳定 code：

| 错误码 | 次数 | 含义与恢复结果 |
|---|---:|---|
| `edit_old_text_not_found` | 5 | 观测版本中的旧文本不存在；模型重新读取或改用其他编辑方式后继续 |
| `terminal_exit_nonzero` | 3 | 被测工程命令真实返回非零；模型读取输出并继续修正/验证 |
| `EISDIR` | 1 | 把目录交给 `read_file`；模型改为目录/文件级工具后继续 |

这些失败没有被错误消息正则重新归类，也没有让工具永久停留在 running。67 个成功 Fact 均为 verified/semantic true，9 个失败 Fact 均为 failed/semantic false。

### 5.2 与修复前复杂长测的对比

修复前基线来自 `RUNTIME_MCP_REAL_API_DATA_ANALYSIS_2026-09-01.md`。模型生成路径具有非确定性，因此轮次、工具数和耗时只用于规模说明，不作为性能回归判据；协议一致性、终态、重试和 Cache 才是本轮判定指标。

| 指标 | 修复前基线 | 旁路修复 | 变化 |
|---|---:|---:|---:|
| Prompt Cache 命中率 | 95.9886% | **97.6890%** | +1.7004 个百分点 |
| Provider 重试 | 0 | 0 | 持平 |
| 一致性违例 | 0 | 0 | 持平 |
| 明确终态 | completed | completed | 持平 |
| 模型轮次 | 36 | 55 | 非确定性路径，非失败 |
| 工具调用 | 50 | 76 | 覆盖规模增加 |
| Runtime 事件 | 38,190 | 46,772 | append-only 覆盖规模增加 |

## 6. 合并判断

建议并入，理由：

1. 回放证明事件顺序、游标和明确终态未受破坏。
2. 完整门禁全绿，内部严格协议升级已经覆盖所有生产者与消费者。
3. 真实 API 在更大规模的 55 轮、76 工具场景中完成，0 重试、0 一致性违例。
4. Cache 命中率没有因取消 continuation 兼容重试而下降，反而由 95.9886% 上升至 97.6890%。
5. 改动删除 444 行、增加 335 行，整体减少状态别名和语义猜测面。

合并后应把 `test:nonsemantic-root` 保留在发布门禁中。今后若协议新增状态，必须先升级 Schema、生产者、fixture 和消费者；不能在 UI 再补同义词或错误文案兼容。

## 7. 边界与剩余风险

- 本轮没有改变 append-only Session/Event/Fact 链，也没有处理其存储膨胀问题。
- 没有修改 `game` 原项目。
- 没有针对 DeepSeek、某个模型 ID 或某类工具设置特殊路径；真实 API 只作为通用协议的压力验证。
- 第三方标准 MCP 若不提供 CardBush Execution Fact，语义状态仍保持 unknown/unverified；这是 fail-closed 信任边界，不能靠读取输出文本补齐。
- 本次严格化会拒绝缺少 `RuntimeProtocolError.kind` 的旧内部帧。这是有意的协议升级，不提供兼容回退。
