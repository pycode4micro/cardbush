# Bush TypeScript Runtime

[English](README.md) · [简体中文](README.zh-CN.md)

本包负责与 Provider 无关的 Agent loop，不渲染 UI、不管产品设置，也不从文本、工具名、语言、框架或生命周期状态组合推断任务语义。

## 模型失败边界

`modelFailurePolicy.ts` 为执行 loop 和缓冲 assistant 轮次统一分类规范化失败，以 HTTP 状态及结构化错误码决定，任意错误 prose 不能打开传输重试。

| 失败 | 处理 |
| --- | --- |
| 408/409/429，5xx 除 501/505 | 同轮有限退避，尊重有界 Retry-After |
| 连接中断/超时/缺终止事件/已识别暂时 SSE | 同一传输重试 |
| 鉴权、额度耗尽、永久 HTTP/输入、未知 SSE | 停止并保留原原因 |
| 已识别上下文溢出 | 原有限压缩恢复 |
| 非法/不完整工具批次 | 任何调用执行前最多一次纠正 |

Provider 可明确禁止重试，例如 429 账号资格限制；retryable:true 不能覆盖永久状态或把上下文/工具修复当普通断线重试。每个不变模型轮次共享一个 `ModelRequestAttempts`，最多一次 wire recovery（旧 continuation 或不支持可选能力），之后暂时失败仍保持修复投影，不按修复类型独立加额度。有限传输 cap=N 时最多 N+1 次生成，不嵌套放大；主 loop 可配置有限 cap 或 null 持续重试，缓冲 assistant 最多三次。取消中断退避、阻止后续分派。

失败尝试输出会被替代，已完成工具及持久结果仍权威。wire/transport 恢复都不执行工具。诊断分别记录真实 providerAttempts/recoveryAttempts 与外层编号。

## 会话、上下文与压缩

`ConversationJournal` 也保存产品对话事实（最终语音转写、页面发布、任务反馈），带来源/可见性，独立于执行 turn 追加，读取不占 turn 锁。entry ID 去重，assistant context generation 拒绝 reset 后迟到写入。

`AssistantConversation` 用共享模型轮次适配器和五个受限对话工具；`RealtimeAgentDispatcher` 经原 subagent 和持久 Session loop 执行，沿用工作区/权限，读/跟进留原 child host，重置父对话不取消已分派子任务。对话摘要保留原日志，与跨会话习惯分离。见[个人助手](../../docs/PERSONAL_ASSISTANT.md)和[实时语音](../../docs/REALTIME_VOICE.md)。

`SessionStore` 是只追加事实日志。Turn 原子提交稳定 turn/message 身份、顺序索引、终态、原因及用量；同 turn ID 仅在全部事实一致时可复用。替换历史需明确 message ID 和理由：独立替换用 messages_superseded，编辑/重跑用修订校验 supersession，仅投影活动 turn 并与 turn_committed 原子保存。准备失败不改变旧有效历史，检查点保存意图以恢复而不重放。

`RuntimeSessionCoordinator` 按固定前缀、未被显式替代的有序已提交消息、当前输入组装；`assembleContext` 不改已提交内容。之后可用单个 `turn_context_summarized` 赋不可变 contextSummary，模型投影一条内部摘要；历史/审计/fork 仍读原消息与工具。工具调用/结果相邻关系机械校验。

默认桌面、服务、CLI 在**实际压力时**从完整 turn 的工具名称、既有 reason/display title、参数、观察结果和准确终轮回复推导 recorded handoff，无逐 turn 总结调用或额外模型字段。原用户指令/纠正顺序保留；工具返回不标作业务成功，失败/未完成、嵌套状态、ID、权限及未知元数据保留。已知大文本可带原历史定位器作显式首尾节选，未知文本/失败诊断保留全文；Skill/指令来源、图像交换、旧检查点不随意损失。

只有完整重建请求变小且满足 token 余量及请求体限制才应用，否则模型 checkpoint 兜底（含尚在执行的 turn）。引用 recorded_v1 和来源 digest 通过只追加事件保存，原事实不删；重启协调引用，不重放业务。比较实验可 `preferRecordedToolHandoffs:false`；旧 `preferPreparedToolHandoffs` 仅 opt-in，已应用旧摘要/冻结调用仍可读。

当前 `summary_for_user` 只含可选习惯/预测，兼容旧 tool_summary 但不要求。工具工作完成后单独调用以标记终轮展示，没有新记忆/关闭时 `{}`，纯对话无需。它不结束 loop、不准备压缩，宿主不补缺失调用或阻止终轮。旧 v4 从 v2/v3 的迁移属于历史一次性更新；当前产品策略版本以运行代码为准，不兼容合同可要求新会话，不能从旧迁移记录推断任意版本可自动升级。

完成 turn 不立即替换历史/改下轮前缀。普通只追加请求保持已有前缀及固定模型/工具参数；实际压缩边界可损失部分缓存，即使没有额外模型调用。cachechain 只诊断结构，命中以 Provider usage 为准。历史实测见 [recorded compaction](../../docs/RECORDED_TOOL_COMPACTION_2026-10-23.md)。

### 模型 checkpoint 兜底

`checkpoint_context` 常驻稳定 schema，不因压缩缩减工具。模型不能主动调用；Runtime 在 resolveContextBudget 的压力阈值发显式 developer maintenance，预留 checkpoint 输出及安全余量。普通 Provider dispatch 同样预留输出，省略时使用有界默认（最多 8192 tokens）。

增量 schema 接受当前来源索引中的 pending source updates。混合错误中合法项保留，接受后文字不可覆盖；所有授权来源（包括精确累计边界的活动 turn）完成才应用。新事务一次展示一个历史来源，旧已接受摘要仅背景，真实当前用户输入在历史范围外；当前索引优先于早先回执，避免冻结位置覆盖重映射。旧中断事务保留输入模式。

超 token/显式传输预算时按完整消息/工具交换分片，保留全局来源编号，模型合并片段后才接受整个来源。已完成片段作背景，不重复附原图。真实调用、回执和分片边界跨重启保留，小投影不取代规范历史。优先完整交换分区，只有不可分超大交换才用归档预览或拒绝。模型、思考强度、输出预算沿用会话。

继承 checkpoint 按其承载的会话要求/结果索引，不只看承载 turn 的暂停回应。历史全为摘要且活动 turn 满足近期配额时，按序列化体积选最老约 2/3（完整来源边界）请求模型合并，较近内容保留。范围、传递覆盖、merge 标记持久化，不做本地语义排名/关键词正确性/静默删除；年龄按最早继承 turn。选区有近期间隔就仅包含准确范围，分片/重启保留间隔。合并摘要只保存在真实工具调用字段，回执引用，不重复拷贝。

合并回执含 `conversation-history://turns/first/last`，延迟 `read_conversation_history` 从当前 Session 既有日志读有界修订校验 NDJSON（含纠正和终轮），省私有推理/回放/图像载荷，标 superseded，不授予文件或跨会话权限；相对定位在 fork 可用。语义仍由模型负责，Runtime 校验身份/范围/完整请求容量。

目标为阈值下最多 20%（cap 16k tokens）余量。有限收紧后，若至少留一半目标余量、比旧输入小、满足硬 token cap 且低于传输警戒，可接受并在完成事件记录，不因差几 token 的理想目标让会话永久不可用。完整容量校验先于应用/完成事件。

接受引用真实模型调用及回执，保留用户原文，继续同 loop 而不重放已完成副作用。原 assistant/tool 留只追加日志，不存在静默删除旧摘要的无记录兜底。三种 API 默认 JSON 40,000,000 字节，35,000,000 启动维护；`maxRequestBodyBytes` 可覆盖已知传输上限。见[图像/请求预算](../../docs/MODEL_IMAGE_BUDGET.md)。

每工具轮共享由最新输入测量、真实输出和 checkpoint 预留推导的 aggregate ingress budget，不能各自独占 16,000 字符；图像也占同预算。原结果在 ToolExecutionStore，模型缩短投影带 durable tool-result://。旧超大会话使用仅请求恢复投影，先缩大归档结果再完整分片，保留推理/Provider 回放/所有并行回执，不改原日志。

压缩生命周期 started/retrying/completed/failed/cancelled 有稳定 ID、持久化，但属于维护事实，不入模型/普通工具计数/文件撤销；UI 可用熟悉工具行展示，摘要文字只存 checkpoint 不复制进展示事件。

## 恢复、停止、档案与计划

Session 事件为带校验和 JSONL，完整损坏拒绝，崩溃后仅不完整尾记录可截。检查点保留生成消息身份和累积用量，使工具后中断可恢复并只提交一次。桌面启动把崩溃遗留检查点结算为 stopped turn，释放单活动门。

Stop 是 loop 边界，不回滚历史或隐式关所有进程：abort 当前 Provider/tool 等待，给原生协作 stop 250ms，再必要时投影恰好一个取消事实，提交已有文字和已完成结果并释放会话。不配合 abort 的 Promise 脱离，迟到结果不追加第二终态。后续用户消息接在已停止 turn 后，hash-only cachechain 基线继续，显式编辑/重生成则正确报告真实断链。

Utility Process 在显式 state root 的独立目录保存 Runtime、checkpoint、Session 及工具校验和日志。工具保存准入 manifest、准确原生结果、Runtime 所有改动或调用错误；Runtime 不从文本抽业务事实/路径/效果，不将 MCP isError 猜成宿主语义。桌面直接消费，无 Python HTTP/SSE 中转。大结果全文留档，模型用精确已发 `tool-result://` 调 `read_archived_tool_result`，不是通用文件/Skill/知识读取器。

归档页按实际共享交付预算裁定，next_offset 只越过确实交付文字/完整搜索项，截页仍未完并留原 locator。MCP schema 整项延期，未完整交付不能调用。执行搜索独立保存有界任务 ID/本地产物路径，准确引用优先工具名；归档读取不重复入搜索索引。

Plan/Goal 独立 Coordination 只追加日志，只强制身份、单调修订、稳定节点 ID、显式范围变化。语义完成是模型/调用方声明，不从文字或状态拼猜。`update_task_plan/update_goal` 普通注册，Session/identity/revision 由 Runtime 填，目录是唯一模型定义源。普通 assistant 终轮文字完成 turn，不提升成工具执行事实。

## 子 Agent

本地 fork 精确继承分派前对话，进入普通 child Session turn；立即返回 submitted，后台运行，父可继续独立工作，完成结果仅在轮次边界进入。父想结束但仍有活动子任务时，Runtime join 并注入终态结果，要求一次对账轮再提交父终态。无独立工作时可 tasks wait 一次显式 join；子任务等待省 yield_time_ms 等完成/新引导，0 为快照、正数为超时，避免周期性模型轮询。

选定本地任务从现有日志派生 phase/活动/模型请求/唯一完成失败活动调用数，不唤醒模型、不暴露推理/文件/参数，审批从原 broker 读取。不读未选中历史。远程只展示其协议实际提供的证据，无依据不冒充本地进度。父追问保存 parent 作者，只有 human 消息触发直接用户提醒。

跟进原 task_id 可带文字和 queue/insert 交付，或对待处理交互提交 response；保持原 child、角色、主机和权限，不能重配身份。子问题经 ask_parent/父等待唤醒共用通道；授权用结构化响应，不靠文字。远程角色固定 connection/agent ID 和角色 revision，具体看[协议](../../docs/SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)。发现/只读/并行安全是显式声明，不推断。生命周期为带校验和只追加日志。

## 文件与终端权限

默认工具提供准确读取、ripgrep、受保护写/改、终端。改现有文件前该上下文须观察当前 SHA-256，fork 可继承仍未变的观察。canonical path 和链接先解析再判断工作区；外部能力绑定准确 action/resource，allow 必须恰好原请求集合。Session 缓存把 capability ID 与 action/target绑定，ID 复用到不同目标不能复用授权，也不重写工具 ID/回执。

协调器统一执行 all_free（含嵌套/子 turn），普通 ask 可自动授予而不发 UI，工具 deny 和宿主强制边界仍最终。命令不按语义重写，保留确定性硬例外：直接删除文件系统根、用户 home、home 兄弟、项目/工作区根，在执行前拒绝且不可审批。

terminal_exec 在 yield 内结束返回输出/退出，否则 running+稳定句柄，terminal_poll/write/list/stop 管同句柄，不阻塞 loop。取消等待不自动停进程。路径协议只控制声明路径/cwd，AppContainer/bubblewrap 才提供启用时的 OS 隔离，目录审批本身不约束命令所有可访问路径。

回执保留请求 cwd、活动 sandbox scope、原生码、supervisor commandStarted。未启动拒绝无命令 exit code，监督状态单列。PowerShell 从进程 cwd 初始化 provider location，不可达就失败而不换目录；typed ErrorRecord 提供有界解释器诊断，即使 stderr 被抑制，也不证明无部分副作用。exit1/本地化文字不直接判权限失败，归档后模型仍保留拒绝分类/sandbox状态。

environmentDiagnostic 区分 shell lookup、access denied、未验证 sandbox 失败，不混同宿主安装状态。typed command-not-found 可在绝对 host PATH 有界查简单命令元数据，不执行发现程序、不授予权限。PATH miss 不证明没装，venv launcher 失败不证明解释器坏；先查范围/申请窄权限，不重装或绕沙箱。

Windows 普通 drive 初始化无法进入获准 cwd 时，用根在该 cwd 的 provider drive；诊断保留 location，不再重新进入绝对路径，不给祖先 ACL/目录列举权。传物理目录给原生程序使用 `(Get-Location).ProviderPath`。
