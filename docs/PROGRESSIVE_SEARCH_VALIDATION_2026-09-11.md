# 渐进式搜索验证

## 行为

- MCP：`mcp_search` 默认返回名称、简短描述、服务标识和分页信息，不附带完整 schema，也不使尚未加载的工具变成可调用状态。
- MCP 深读：`mcp_search({"action":"load","query":"搜索结果中的准确名称"})` 返回一个完整定义。完整定义进入可见上下文后，才允许调用；后续轮次和重启继续从原始历史恢复，无需重复 load。
- Skill：`search_skills` 返回名称、简短描述和 `mainResource` 中的 SKILL.md 路径。沿用 `read_file` 读取正文，没有新增 load 动作。插件技能保留 `invocation`，仍通过 `run_skill` 执行。
- 目录描述超过 512 字符时标记 `descriptionTruncated`；完整 MCP 说明由 load 返回，完整 Skill 说明保留在原文件中。
- 保留现有权限、会话范围、定义版本、取消及归档机制。超出输出预算的 load 保存完整原始结果，通过既有归档读取机制取回，不把预览当作已加载 schema。

## 验证结果

- Runtime 全量回归：416 项通过，串行运行。
- Responses Provider 全量回归：118 项通过，串行运行。
- Runtime、Provider 构建及应用 Node TypeScript 检查通过。
- 针对性测试覆盖默认搜索、准确名称加载、同名歧义、隐藏及其他会话的工具、超长描述、完整归档、权限撤回、重启恢复和压缩后的重新加载。
- 原生 `tool_search` 和通用函数模式均完成本地模拟服务的“搜索 → load → 调用”闭环；两种模式均验证已接受请求的工具参数稳定、旧输入前缀不变。超长 MCP 名称在搜索中保留真实查找标识，只有原生函数声明使用传输别名。
- 通用模式第一次遇到明确的原生协议拒绝时，诊断如实记录一次 `tools` 参数变化；后续搜索和 load 不再改变已接受请求的前缀。测试没有忽略这次协商变化。

## 真实历史离线回放

会话：`local-0aac57a0-db1b-4de9-8e24-65fb00821e70`。

从原始工具执行记录提取当时的定义，在禁止网络和历史工具执行的本地目录中复现 4 次搜索；逐页核对命中名称及顺序一致。

| 搜索结果体积 | 字符数 |
| --- | ---: |
| 原模型可见结果 | 45,166 |
| 渐进式目录结果 | 11,413 |
| 减少 | 74.73% |

这些数据只比较相同命中页的搜索返回，不包含模型后来选择 load 的成本，也不代表 API token 节省或缓存命中率提升。目录使用历史中实际记录的定义，未记录工具不参与模拟，不比较完整市场的命中总数。

另对两轮历史完成上下文投影回放，新增用户消息保持原前缀。两项回放均校验生产记录字节未变，没有真实 API 请求。

重放命令：

```powershell
node scripts/replay-progressive-search.mjs local-0aac57a0-db1b-4de9-8e24-65fb00821e70 tmp/progressive-search-replay.json
node scripts/replay-cache-projections.mjs local-0aac57a0-db1b-4de9-8e24-65fb00821e70 tmp/progressive-search-history-replay.json
```

本次升级修改了稳定的搜索工具定义，升级后的首次请求可能需要建立新缓存。后续按需读取以工具结果追加，不改写既有执行历史。服务自身的 schema 发生变化时，仍遵循已有的版本校验及原生声明替换规则，不承诺这类定义变化也能保持原缓存前缀。
