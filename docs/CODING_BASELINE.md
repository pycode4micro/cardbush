# CardBush 编码基线与首轮改进

这轮实现包含 Responses 原始输出回放、`read_file` 按行读取，以及可重复的编码修复任务。模型能力和运行时效果需要通过相同模型、相同任务、相同预算的实测比较；离线测试通过不能代表模型修复成功率。

## 已实现的行为

### Responses 历史回放

Provider 在响应结束时保存原始 `response.output` 中的 assistant message、reasoning 和 function call，包含每条消息自己的 `phase`、item id、顺序以及返回的 encrypted reasoning。不能把多个原始消息合并后只保留一个 phase。

Runtime 用不透明的 `providerReplay` 携带这些数据，绑定模型、provider binding revision 和消息指纹。Session journal、checkpoint 和重启后的下一 Turn 均保留它。模型或 binding 变化、正文或 Tool call 被编辑、terminal snapshot 与已收集的输出不一致时，适配器回退到原有通用消息投影。旧历史仍可读取，已经丢失的原始字段无法补回。

当前 Turn 的有效 `previous_response_id` 仍使用增量输入，避免重复提交历史。Runtime 不解释 phase，不据此判断任务结束。响应中的传输头和凭证不进入 replay envelope。

紧急上下文维护删去 reasoning 时，也删去对应的不透明 replay，避免把已移除内容重新放回请求；持久化原始历史不变。完整 replay 会增加本地历史存储。Provider 不支持精确输入计数时，现有 JSON 估算也会把 envelope 计入，因而可能更早触发压缩；应在真实评测中观察这一成本。

协议依据：[OpenAI phase 参数说明](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5#phase-parameter)、[Reasoning 历史管理说明](https://developers.openai.com/api/docs/guides/reasoning)。

### 按行读取

```json
{"path":"src/example.ts","start_line":120,"line_count":80}
```

- 行号从 1 开始；返回 `content`、`start_line`、`end_line`、`total_lines`、`next_start_line`、`path` 和整文件 `sha256`。
- 只给 `start_line` 默认最多 200 行；只给 `line_count` 从第 1 行开始；都省略时保持完整读取。
- 保留原始 CRLF、LF、CR 和 Unicode，不给文件末尾的换行额外制造一行；空文件或起始行超过 EOF 时 `end_line` 为 `null`。
- 采用流式扫描，只保留选中行。为了保留整文件版本校验，仍读取并哈希所有字节；减少的是输出和驻留内容，不是磁盘扫描量。单个超长行仍可能很大。
- 文件读取期间发生变化会报错，不能产生新的编辑凭据。后续 `edit_file` 仍要求整个文件版本匹配，读取范围之外的变化同样会拦截编辑。

## 固定任务

`scripts/coding-benchmark/reference/` 保存固定的 CardBush 源码快照和 SHA-256；`suite.mjs` 定义故障注入，`grader.mjs` 检查外部可见行为。它们是来自真实模块的受控回归样本，难度较低，适合发现能力退化，不能替代复杂仓库实测或通用编码榜单。

| ID | 检查内容 |
| --- | --- |
| `queue-scope` | 跨 scope 拖拽不能改变队列 |
| `queue-stable-move` | 同 scope 向前、向后移动及其他 scope 位置 |
| `config-concurrency` | 同文件串行更新、不同文件并行、失败后恢复 |
| `context-usage` | 最近请求占用与累计计费量区分 |
| `local-url-encoding` | 本地路径特殊字符和已有 URL 编码 |
| `flac-preview` | 两个模块中的音频识别和预览入口 |
| `markdown-code-boundary` | 正文链接规范化不能修改代码 |
| `file-reference-boundary` | 日期不能误识别为本地路径 |

每个候选工作目录只包含所需源码、任务说明和公开 smoke test，Agent 可以添加回归测试。评分器和参考答案保留在候选目录之外。目录隔离用于避免覆盖原项目；terminal 仍使用现有宿主执行机制，不提供操作系统级隔离。因此这套本地基线适合开发调试，不是防作弊的公开排行榜。

## 运行方式

安装项目依赖后，离线验证无需模型密钥：

```powershell
npm run build:runtime
npm run test:coding-benchmark
```

自检要求每个故障版触发断言失败、参考版通过评分、公开测试可运行；执行器故障或超时不会被当作有效故障样本。附加的模拟模型测试验证用量记录、请求上限和评测自有终端的清理。

生成供 CardBush、Codex 或其他 Agent 修复的独立目录：

```powershell
npm run benchmark:coding -- --prepare --label codex-comparison
# 将输出的各 candidate 目录和 TASK.md 交给待测 Agent。
npm run benchmark:coding -- --grade <输出的runRoot> --label codex-comparison
```

用 CardBush 当前代码直接运行 Responses 模型：

```powershell
npm run build:runtime
npm run benchmark:coding -- --live --config <模型配置JSON路径> --model-id <配置ID> --label replay-range-v1
```

配置支持 CardBush 当前保存格式及旧配置字段：`models` 数组支持 `id`、`api_key`/`apiKey`、`model`/`model_name`/`modelName`、`baseURL`/`base_url`/`baseUrl`、`defaultHeaders`/`default_headers`；没有指定 ID 时使用配置中的 `default_model_id`/`defaultModelId`。也可使用已有的 `OPENAI_API_KEY`、可选 `OPENAI_BASE_URL`，再通过 `--model <模型名>` 指定模型。密钥只在本地读取，不写入参数或评测报告。

可选参数：`--tasks queue-scope,flac-preview`、`--reasoning high`、`--max-rounds 24`、`--timeout-ms 300000`、`--token-stop 150000`、`--max-output-tokens 4096`。预算按每个任务计算，默认每次响应最多 4096 output tokens，输出上限可单独调整并记入报告。达到已报告的累计 input（含缓存）+ output token 阈值后，不再发起下一次模型请求；最后一次响应可以越过阈值，缺失 usage 时依靠请求次数和时间上限。因此 token-stop 不是金额硬上限，也不是单次上下文窗口上限。

Live 使用固定工具子集和 `task_free` 权限模式，不调用子 Agent。遇到权限请求会停止该任务，并在报告中记录原因；不自动批准工作目录之外的操作。实际模型调用只由显式 `--live` 启动。

## 报告与比较

结果保存在 `tmp/coding-benchmark/run-*/`，包含 manifest 和对应模式的 JSON 报告。报告记录任务评分、耗时、平台、Node 版本、suite/source hashes；Live 额外记录模型、reasoning、预算、相关 Runtime 源码指纹、模型请求次数、usage、工具调用及错误、停止原因、权限请求和清理结果。

每题还在候选目录之外保存 `runtime/diagnostic-trace.json`：模型实际收到的可见消息、完整工具参数和原始执行记录、任务源码的版本快照、逐次请求的 finish reason/usage、输出截断和压缩事件、终止事实与评测器停止原因。它不保存 provider 配置、凭据、原始传输错误或隐藏推理正文；记录包含本地源码和命令输出，不应当作脱敏公开报告分发。新增或临时文件仍可通过原始写入参数和 Workspace Change 证据查阅。

Runtime 的 `stopped / turn_stop_requested` 表示运行被取消；评测器的 `stopReason` 记录预算、超时等具体原因。它们与 `failed`（执行故障）、`completed`（模型正常结束）及独立功能评分分别统计。历史评测曾将输入计数阶段的取消误记成 Provider 失败，旧报告保留原始证据；修复与职责边界见根因报告的“八题复测之后”一节。

用 `node scripts/coding-benchmark/analyze-trace.mjs <diagnostic-trace.json>` 查看逐轮数据和失败编辑比较。反斜杠/换行变换只用于解释匹配失败，不参与任何文件写入。

`--grade` 只评分现有修改，不推测外部 Agent 的耗时、token 或人工介入次数。Live 是无人值守执行，`humanInterventions: 0` 表示运行中没有人工答复；权限阻塞单独记录，不能解释为任务顺利完成。

比较时固定 suiteHash、模型、reasoning、预算、工具范围与运行环境，用 label 标记不同实现；重新准备候选目录，避免复用已经修好的工作区。至少重复多次，比较各任务结果、总成功率、耗时和用量。不同模型的结果不能用来单独推断 Agent 壳的优劣。

源码快照不会自动刷新。只有明确要建立新版本基线时才运行 `node scripts/coding-benchmark/snapshot.mjs`，随后重新自检；这会改变 suiteHash，旧结果应保留各自版本。

## 本轮验证记录（2026-09-06）

本地 Windows、Node v25.9.0：Runtime 全部工作区构建通过；protocol/runtime/OpenAI adapter 共 328 项回归测试通过；整项目 TypeScript 检查通过；8 个故障任务全部满足“故障版断言失败、参考版通过”；5 项离线评测驱动测试通过。`--prepare` 与 `--grade` 也实际验证了未修复失败、恢复参考实现后通过。

上述为最初的离线验证记录。后续首次真实模型评测已完成，见 `docs/CODING_BASELINE_LIVE_2026-09-06.md` 和同名 JSON：DeepSeek 默认模型独立评分 6/8，预算内正常收尾 3/8；尚未进行 Codex 对照。

随后完成根因诊断及工具文本呈现、字面替换、PowerShell 退出状态修复。最终按原模型和预算完整复测：独立评分 8/8，正常收尾 5/8，编辑匹配失败 0 次。完整证据、限制及 12,800 输出上限的独立试验见 `docs/CODING_ROOT_CAUSE_2026-09-06.md` 和同名 JSON。
