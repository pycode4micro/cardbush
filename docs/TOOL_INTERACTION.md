# 工具交互与结果定位

这些能力实现在共享 Runtime。本机和云 Agent 使用相同的工具协议；直接 SSH 的文件、搜索和终端路径也支持对应参数。

## MCP 发现

`mcp_search` 的 `action=search` 只返回短摘要、是否已加载及分页信息。固定操作说明留在工具定义中；模型看到的搜索结果不再重复协议、会话、服务器、底层名称和 next_step。原生执行记录仍保留完整事实。

搜索按完整词匹配并忽略常见英文虚词，优先准确工具名、有效查询词覆盖率及工具名／服务名匹配，避免 `web` 命中 `webp` 等无关子串。Browser Use 的工具描述明确支持通过搜索引擎网页查询新闻和当前信息。搜索只覆盖当前会话可见的工具，部分命中或没有命中不代表浏览器／相关能力不可用。

首次使用 `query`（`*` 表示目录，可用 `server` 缩小范围）；后续把 `next_cursor` 原样传入 `cursor`，可调整 `limit`，不再传 `query`、`server` 或数字 `offset`。游标绑定原查询、会话和排序结果；更换查询从第一页开始，相关目录变化后要求重新搜索。重复读取同一游标得到同一页，不因搜索或阅读而隐藏已返回工具。`more` 和 `next_cursor` 保留在模型看到的结果中。

`action=load` 在最终模型请求中同样省略 `protocol`、`sessionId`、`next_step` 和值为 false 的 `more`，普通函数调用与原生 tool_search 路径一致。完整 schema、修订信息、分页、批量错误和 `deferred` 保留。精简发生在 Provider 发送边界；Runtime 历史保留原身份信息用于重连、压缩和恢复校验，不改写已保存的消息。超大结果的归档正文及分段偏移保持原样，普通工具返回和 Hook 替换内容不受影响。

一次加载多个已知工具：

```json
{"action":"load","names":["mcp__server__first","mcp__server__second"]}
```

最多 16 个名称，自动去重。成功项返回完整 schema，缺失、歧义和不可见项分别报告错误；超出批量展示预算的项放入 `deferred`，不被标记已加载。单个特别大的 schema 走现有归档机制。单项加载使用 `action=load` 和精确 `query`，不接受旧 `reload` 参数或无 action 的旧加载结果。加载不执行工具，也不授予权限。压缩后只有完整 schema 仍在实际上下文中，才视为已加载。

## 结果与执行历史

`read_archived_tool_result` 支持 `query`（大小写不敏感的字面关键词）、`context_chars` 和 `limit`。返回命中 `offset`、`end_offset`、`context_offset` 及上下文。用 `next_offset` 翻页；省略 query、指定命中 offset，可继续读精确原文。片段不会被误认成完整 MCP schema。

`search_execution_history` 每页仍最多五条，可翻页；有完整原文的摘要新增 `tool-result://history/...` 引用，由当前会话/项目范围解析。跨项目读取被拒绝，原会话删除后失效。引用不让已经删除的会话缓存继续存活。旧索引自动升级，原执行日志不改写。

## 计划

`update_task_plan` 支持：

- `action=get`：读取当前计划及 revision，无计划返回 null。
- `action=replace`：兼容原全量节点提交。
- `action=patch`：必须携带 `expected_revision`，通过 `updates` 按节点 ID 修改，`append_nodes` 追加，`remove_ids` 删除。未提交的字段和节点保留。

例如：

```json
{"action":"patch","expected_revision":2,"updates":[{"id":"existing-node-id","status":"completed"}]}
```

修改原子提交。版本冲突、无效/重复节点、违反单个 in_progress 等约束时整次失败；删除活动计划中的节点仍需 scopeChangeReason。

## 文件

`search_file_content` 增加 `context_before`、`context_after`，分别为 0–100 行，默认 0。ripgrep、本机后备搜索与直接 SSH 都支持。

`edit_file` 保留精确文本模式，新增 `start_line`、`end_line`（从 1 开始，含首尾行）及 `expected_sha256` 的行范围模式。SHA 必须来自 read_file；new_text 替换完整指定行，包括原行末换行符。两种模式不可混用。版本过期或范围越界会失败，避免猜测位置或忽略缩进。

精确匹配未命中、多处命中、版本过期或行范围越界时，错误明确说明本次没有写入，要求不要重复提交同一失败参数，先 `read_file` 确认当前内容及 SHA，再选择唯一文本或行范围修改。`replace_all` 仅用于确实需要改动全部匹配项的场景。本地、独立 Agent 和直接 SSH 复用相同恢复指引，SSH 的宿主错误传输也保留这段说明。不自动放宽空白、缩进或内容匹配。

终端完成通知见 [后台等待与续接](ASYNC_TOOL_AND_SUBAGENT_CONTINUATION.md)。新增结果只追加，已发送的消息和本轮工具快照保持稳定。

验证：`npm run test:tool-ergonomics`。
