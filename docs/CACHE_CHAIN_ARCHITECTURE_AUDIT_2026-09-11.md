# CardBush 上下文与 Cache Chain 架构审查

2026-09-11。范围：压缩交互、历史/恢复投影、token 预估、工具发现、Provider 请求拼接及界面历史。没有调用付费模型，也没有执行历史工具或改写用户的原始会话。工作区中原有的插件卸载改动保留。

结论：当前单一会话事实记录和派生上下文的方向可以保留。问题主要集中在压缩交互被丢弃后重新制造消息、预估重复计数、恢复沿用过期用量，以及只检查 Runtime 消息而看不到 Provider 改写。后续复核还发现全局估算倍率只能上调，且轮内的用量下限未逐次核对前缀；现已改为绑定真实请求的前缀校准。没有加入模型名称分支、任务语义分类器或经验检索提醒。

**实际会话证据**

`local-1b1a2d3b-27b9-4af4-95b6-d84cce460ff4` 的失败长轮有 30 次成功返回用量的请求：输入合计 1,434,369 token，缓存输入 1,374,208，累计命中约 **95.81%**。第 30 次输入 105,462，缓存 103,040；随后压缩重建上下文，下一次报缺少 `reasoning_text`。这说明该样本首先暴露的是压缩后的协议错误，不能据此断言整条链的缓存一直很差；失败请求没有返回缓存用量。

压缩前预估为 150,320，维护请求预估为 151,289，明显高于实际约 10.5 万输入。对这一轮保存的消息体单独回放，旧 JSON 存储估算为 142,128，实际发送结构估算为 96,363，差 45,765，约 32.2%。这两项是字符估算，仅比较消息体，不含当时完整的系统指令/工具目录，也不是新的真实 API 计数。

另一个样本 `local-4483104f-ae16-412a-82db-7160d23f56d1` 显示：新增大量内容后，单次命中比例会降到约 70% 或 67%，紧接着又回到约 99%；模型切换后的首次请求也出现冷缓存。因此还必须同时看新增输入、未缓存输入量和模型/连接变化，不能只看百分比。

**修复与对抗结果**

| 边界 | 原来的问题 | 本轮处理 |
| --- | --- | --- |
| 压缩交互 | 丢弃真实模型的压缩输出，重新构造摘要消息；改成 user 只能绕过部分协议检查，改变了角色来源 | 保留真实 assistant reasoning、原生 replay、checkpoint_context 调用及实际 tool 回执；检查点只引用原始消息 ID |
| 历史替代范围 | 先修改旧轮摘要，再保存当前检查点；多处摘要投影可能重复 | 覆盖的轮次和真实交互随同一个恢复/提交记录保存；旧轮保持原样，活跃轮、结束后和重启后共用投影 |
| 旧摘要兜底 | 压力过大时自动保留最后 20 条乃至更少，结束后旧摘要重新出现 | 移除循环中的静默裁剪；旧摘要也可作为明确压缩来源；不可缩且超限时明确失败 |
| 输入预估 | 把消息正文/工具调用与 providerReplay 副本一起计数，图片 base64 还会膨胀字符估算 | Provider 按完整发送视图估算一次；续传也计算完整上下文；图片单独估算，保留“估算”标记和真实计数优先级 |
| 恢复用量 | 压缩前的大输入用量可能继续被当作新上下文的最低值 | 为用量保存来源前缀指纹；仅在该前缀仍被延续时复用。编辑、压缩或请求前缀变化后失效 |
| 校准与新增输入 | 全局倍率只增不减，估算偏高时仍按整个上下文重复估算；循环中的下限可能滞留 | 真实 usage 绑定实际发送尝试的完整投影与估算版本。前缀相同时使用真实前缀用量，只估算新增部分；每次新 usage 替换基准，结构变化立即失效 |
| 不完整末尾快照 | 只校验正文和调用，漏掉已流式返回但未进入末尾快照的 reasoning | 不完整的明文快照不能覆盖已收到的 reasoning；保留不透明的原生推理数据 |
| Cache Chain 观测 | Runtime 只追加，并不证明实际 API 输入只追加 | 新增 provider_input_observed，记录最终输入项指纹、首个断点、参数变化和传输方式；不记录正文或凭据 |
| 编辑与来源索引 | 完全被替换的旧轮或已被当前检查点覆盖的来源可能再次进入索引 | 按实际可见投影选取来源；不存在的边界、错配调用/回执及未来轮次引用被拒绝 |
| 界面历史 | 保存真实压缩交互后可能显示维护 reasoning/正文 | 通过原始消息的维护元数据过滤展示，沿用现有压缩事件 UI；不改动模型历史 |

工具发现的对抗测试刻意验证了一个容易误判的场景：相同 schema 的重复发现保持前缀；**同名工具 schema 真正更新时**，为了满足服务端工具名唯一约束，现有投影会删除旧声明并放入新声明。Runtime 此时仍然只追加，但 API 历史的旧项发生变化。现在这个断点会被记录，测试明确要求它被发现，不把它算作“工具总是在末尾，所以无损”。本轮没有为了保住旧缓存继续向模型提供过期 schema。

**用量校准补充**

发送 reasoning 和计数没有采用两套内容。DeepSeek 明确区分请求是否携带 `tools`：携带时历史 reasoning 会进入上下文；未携带时才会忽略。当前主循环带工具，保留并计算相应 reasoning；没有为了降低本地数字而删除协议必需内容。[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)

无精确计数接口时，新预估为：已测前缀输入量 + 新增部分估算 × 密度修正 + 新增部分安全余量。密度修正只用于新增部分，至少为 1；安全余量为修正后新增估算的 10% + 32 token。完全相同的请求没有未知新增量，复用其已测计数。较低密度的旧文本不会让未知的新文本打折；新一次 usage 会替换基准，不继承历次最高倍率。已测计数与估算在事件中分别标记。

校准要求 Runtime 前缀和实际发送前缀均匹配。原生工具发现回退取最后实际发送尝试的指纹，不把前置估算误绑定到回退后的请求。工具 schema 替换、模型/连接/能力变化、压缩、编辑、估算版本变化均停止使用旧校准；仅发送 continuation 增量时仍核对完整上下文。旧日志缺少投影依据时不能据此降低估算。未提供原生估算器的适配器使用明确标记的 Runtime 表示，不能与原生投影交叉校准。

本地 SDK 集成用例中，第二次请求的完整字符估算超过 12 万，在 14 万窗口与 1 万最大输出的测试配置下会触发旧策略压缩；已测前缀为 2 万，新策略预估低于 7.5 万，三次请求正常完成，保留全部原始 reasoning、工具定义和输入前缀。序列化恢复后，第三次请求沿用第二次实测的 7 万前缀用量。这里的 usage 来自受控本地服务，用于验证机制，不代表新测得的线上成本或命中率。

**仍需明确的限制**

- 后续已按用户确认分离日常与维护输出预算：400,000 上下文、128,000 日常最大输出时，默认维护输出为 16,384，触发边界由约 **141,952** 改为 **253,568**，日常最大输出不变。维护截断、超限分段和恢复的专项实现与验收见[上下文预算与恢复审查](./CONTEXT_BUDGET_RECOVERY_AUDIT_2026-09-11.md)。这一阈值仍保留维护空间，不等于服务端的真实 token 计数。
- 历史 `stable_v1`/旧格式只有摘要文本，无法补造已经丢失的真实 reasoning 和调用。保留明确的兼容投影；新生成的检查点使用 `exchange_v1`。
- 字符估算、图片估算及不透明 reasoning 的估算仍可能偏离真实 tokenizer；有精确计数接口时优先使用。持久化输入指纹和缓存观测是诊断元数据，不是第二份上下文正文。
- 旧日志只有 Runtime 指纹，无法反推出每个历史请求的完整网络字节。新增 Provider 观测只对加载新版后的请求生效；参数变化标记也不等于已经证明服务端缓存失效。
- 本轮没有新增 OpenAI 原生 compaction 接口。官方接口返回的规范窗口应原样续传，和本地文本检查点是不同路径。[OpenAI compaction 文档](https://developers.openai.com/api/docs/guides/compaction)
- 即使结构前缀一致，服务端缓存保留时间、路由、模型和隐藏输入也会影响命中；不能把结构测试等同于线上缓存承诺。[OpenAI prompt caching 文档](https://developers.openai.com/api/docs/guides/prompt-caching)

**验证记录**

`npm run test:cache-adversarial`：18 项对抗用例通过，另有维护交互的 UI 投影检查。覆盖严格 reasoning 接口、连续两次压缩、重启、25 轮旧摘要、工具 schema 更新、协议能力切换、回放重复计数、图片体积、过期用量、估算偏高、密度变化、估算版本变化、缺失 usage，以及实际 SDK 请求的跨轮校准。

补充校准阶段的 Runtime 全量 **391/391**、Provider **114/114**、协议 **27/27**、产品上下文 **8/8** 通过，共 540 项；18 项对抗用例已包含在上述集合，不重复加计。维护交互 UI 投影、前后端 TypeScript 检查和完整 Runtime 构建通过；前一轮的聊天记录和时间边界契约检查仍保留在原验证记录中。后续预算分离阶段的新增用例和最终结果记录在上述专项审查中。

全量测试过程曾暴露会话编辑后的空来源，以及重试测试固定等待 100 次事件循环的竞态，均已处理。重试测试改为等待真实 provider_retry 事件，原有停止操作小于 1 秒的断言未放宽；最终全量没有失败、跳过或待办用例。

历史回放读取了上述两个会话共 9 轮，并对所读日志做前后字节哈希校验；原文件未变。目标会话另完成 42 条工具记录的交付/发现回放。旧的 `local-10489c9d-6f88-449f-913f-31681b07e121` 日志本机已不存在，不计为通过。

可复现命令：

```powershell
npm run test:cache-adversarial
node scripts/replay-cache-projections.mjs local-1b1a2d3b-27b9-4af4-95b6-d84cce460ff4 tmp/cache-projection-replay.json
node scripts/replay-cache-projections.mjs local-4483104f-ae16-412a-82db-7160d23f56d1 tmp/cache-projection-comparison.json
```

最新校准结果保存在 `tmp/token-calibration-adversarial.log`、`tmp/token-calibration-runtime-suite.log`、`tmp/token-calibration-provider-suite.log`、`tmp/token-calibration-protocol-suite.log`、`tmp/token-calibration-product-tests.log`、`tmp/token-calibration-history-target.json` 和 `tmp/token-calibration-history-comparison.json`。前一轮结果仍保存在 `tmp/cache-*.log/json` 中。

主要代码入口：[检查点与用量协议](D:/proj/cardbush/packages/bush-protocol/src/session.ts)、[上下文投影](D:/proj/cardbush/packages/bush-runtime/src/contextAssembler.ts)、[循环与恢复](D:/proj/cardbush/packages/bush-runtime/src/inMemoryRuntimeHost.ts)、[用量来源校验](D:/proj/cardbush/packages/bush-runtime/src/inputTokenBasis.ts)、[Provider 发送投影](D:/proj/cardbush/packages/bush-provider-openai/src/responses.ts)、[原生回放完整性](D:/proj/cardbush/packages/bush-provider-openai/src/responsesReplay.ts)。

输出预算分离和有界恢复已在后续实现。下一步应做小规模受控真实 API 验证，比较相同任务的总输入、未缓存输入、压缩次数、摘要质量和错误率，评估维护输出上限的实际效果。目前不需要重写核心 loop，也不应根据离线测试宣称线上命中率已恢复到某个数值。
