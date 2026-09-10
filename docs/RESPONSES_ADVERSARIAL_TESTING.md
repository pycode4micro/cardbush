# Responses 对抗性测试

日期：2026-09-10。范围：原生客户端工具搜索、Responses 流式归一化、工具结果投影、归档发现与 Runtime 执行边界。

本轮从故障用例先复现，再修复并回归。协议依据为 OpenAI 的 [Function calling](https://developers.openai.com/api/docs/guides/function-calling) 和 [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)；其中 `output_index` 标识输出位置，`item_id` 与 `call_id` 分别标识输出项和调用，不能混用。

## 发现与修复

| 故障条件 | 原有问题 | 修复后的行为 |
| --- | --- | --- |
| 搜索与普通工具并行，结果乱序返回 | 搜索说明插在结果批次中间，服务端误判结果缺失 | 整批结果闭合后追加带调用 ID 的说明及归档定义 |
| 缺失增量、仅有 done 或最终快照 | 工具调用、参数或正文丢失 | 从同一输出项的完整观察补齐缺失内容，保持正文与工具的顺序 |
| 重复 added/done、参数或身份冲突 | 工具名重复拼接、误用 item_id、接受矛盾参数 | 重复观察幂等；身份或参数矛盾在执行前失败 |
| 最终快照省略前面的已完成输出项 | 工具和文本各自记录索引，引发错位 | 使用共享输出项索引，按已知身份恢复原位置 |
| 取消发生在同一快照的内部事件之间 | 取消后仍可能交付完成事件 | 每个交付事件前检查取消；交付终止事件后关闭流，忽略其后的坏帧 |
| 模型或连接绑定变化，原生历史转为通用投影 | 长函数名恢复成超出协议限制的原名 | 两种投影共用确定性别名，执行和历史继续保留原始名称 |
| 归档分片重叠冲突，或完整内容被重复读取 | 冲突内容被拼成完整结果、重复加载大 schema | 检查重叠文本一致性；首次完整读取只贡献一次定义 |

输出达到 token 上限时仍保留 Runtime 的既有续写机制：保存已收到的正文和推理，丢弃该截断批次的调用，后续请求不伪造调用结果。未增加供应商品牌分支、语义分类器或模型选择提醒。

## 自动化验收

- Provider 全量：98 项通过。`responsesAdversarial.test.mjs` 覆盖故障事件与执行边界，`toolSearch.test.mjs` 覆盖能力协商、增量续接、持久化恢复和权限撤销。
- Runtime 全量：349 项通过，包含新增归档对抗测试以及原有上下文压缩、会话恢复、权限和取消测试。
- 200 组可复现的并行流事件交错：调用身份、参数及 Unicode 内容保持一致。
- 5 个混合调用的全部 120 种结果排列：工具结果先于附加说明，增量投影与完整投影前缀一致。
- 本地 HTTP 故障服务经过真实 OpenAI SDK 和 Runtime：恢复与重复事件只执行一次；参数冲突和终止事件前断流执行零次；达到输出上限后能够续写且不执行截断批次。
- 两套应用 TypeScript 检查与 Provider/Runtime 构建通过。

复现命令（仓库根目录）：

```powershell
npm run build --workspace @cardbush/bush-runtime
npm run build --workspace @cardbush/bush-provider-openai
node --test packages/bush-provider-openai/test/responsesAdversarial.test.mjs
node --test packages/bush-runtime/test/mcpDiscoveryAdversarial.test.mjs
```

## 真实服务验证

使用用户当前配置的 Responses 服务，发送虚构的搜索任务与无副作用的内存 echo 工具。第一轮真实返回原生搜索和 echo 两个调用，第二轮接收结果后正常完成。探针不调用用户插件、不执行文件操作、不修改原会话。

该验证确认当前服务上的正常闭环；缺帧、重复、冲突和取消等故障由本地协议服务注入，未对真实服务实施压力或破坏性测试。缓存测试检查请求投影的前缀一致性，服务端缓存命中率仍以其 usage 为准。
