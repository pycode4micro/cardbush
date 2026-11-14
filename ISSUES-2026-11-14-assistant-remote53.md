# 2026-11-14 改动汇总与 Assistant / Remote53 问题记录

本文保留 `03de4054` 中的排查证据，并记录随后完成的源码修复。下方“原始排查”描述修复前的行为，不代表当前实现；修复验证与部署状态以本节为准。

时间均为北京时间（UTC+08:00）。诊断只读取真实记录和服务信息，复现使用模拟模型与隔离临时目录；生产会话、凭据和完整工具日志不收入仓库。

## 当前修复：任务交付状态与 worker 连接状态

三项问题已从运行时和宿主层修改：停止及 inspect 重复唤醒、连接状态歧义、缺少模型可用的验证/重连工具。没有按回复文本、时间窗口或通知 ID 过滤消息。

### 任务执行和结果交付分开管理

- [TaskResultDelivery](packages/bush-runtime/src/taskResultDelivery.ts) 由 [SubagentTaskStore](packages/bush-runtime/src/subagentTaskStore.ts) 持有，Assistant 与普通父 Agent 共用。以父会话、任务和执行尝试管理 `running → ready → delivering → delivered`。执行完成只使结果待交付；读取、投影、上下文提交成功后才确认交付。
- 原生派发回执与 `tasks(stop/inspect/await)` 使用同一份交付所有权。后台完成只唤醒状态检查，等前台工具结果提交后再决定是否需要加入模型上下文，不再在前台回答期间预先排入另一份完成输入。已交付结果不再占用普通父 Agent 的等待项；Assistant 在创建执行状态前检查是否还有实际待处理工作，避免空转状态和虚假的 habit 执行观察。
- `list`、未确认停止、相同 revision 的状态响应、读取失败及截断/替换的结果不确认交付。多任务结果逐项确认；中止或失败释放所有权，其他待交付任务不受影响。模型不能通过工具参数自行确认交付。
- Assistant 的上下文与交付引用写在同一个 [model history](packages/bush-runtime/src/assistantModelHistory.ts) 追加记录里；普通父 Agent 的生成消息附带宿主元数据。恢复从明确的交付记录读取状态，不扫描历史回复判断是否重复。压缩保留交付记录，新执行尝试拥有新的交付状态。输入 metadata 中的交付引用被移除，恢复限定在所属父会话内，不能伪造其他会话的交付确认。
- 前台新消息仍优先处理。父会话隔离、真正未读的异步结果、取消和恢复执行均保留。现有 Team 结果协议保持原边界，本次修改对象是单个子任务的结果生命周期。

### 连接状态与真实验证

- [AgentConnectionManager](electron/agentConnections.mts) 区分未验证、已主动断开、连接中、验证中、已验证、重连中和失败，并返回 `lastCheckedAt`、`verifiedAt` 与受控失败码。`connected` 仍为兼容字段，表示本宿主最近有效的连接缓存。
- `connect()` 继续支持按需复用；`verify()` 对已有连接发起真实的认证与身份检查。并发验证共享正在进行的检查。HTTP 和受管理 SSH 连接均定期检查（默认 15 秒，本地计时，不调用模型）；失败撤销缓存成功状态。
- `reconnect()` 关闭当前宿主拥有的连接后重新建立。操作代次和连接所有权阻止断开、移除、更新登记后旧请求回写成功或重新打开连接。服务身份变化和认证失败停止自动重试；不重新采纳其他服务身份，不重放业务请求。
- 外部 SSH 进程不属于 CardBush 管理器：重连只能重新验证其 HTTP 入口；已登记的受管理隧道才复用 CardBush 的 SSH 能力。重连不会重启远端服务、任务或全局共享 SSH 会话。
- [RemoteWorkers](src/features/team/RemoteWorkers.tsx) 展示本地化状态、最近检查时间和受控失败原因；验证失败也刷新列表。App 与 CLI 共用登记和凭据，但各自的“已验证”状态仍属于各自宿主。

### 模型可调用的宿主入口

- 新增原生 [worker_connection](packages/bush-runtime/src/workerConnectionTool.ts)：`action=verify|reconnect`，参数只接受已登记的 `connection_id`，由 `list_subagent_options` 获取。Assistant、普通本机 Agent 及符合现有工具权限的子 Agent 均可使用。
- App、CLI 经 [callRemoteWorker](electron/remoteWorkers.mts) 和既有宿主桥接调用同一管理器，复用保存的凭据、隧道与身份固定校验。回执由 [workerConnectionStatus](electron/workerConnectionStatus.mts) 白名单投影，不包含 token、私钥、端点或远端原始错误正文。
- 没有宿主管理能力时不注册工具；受限 Web 租户不获得本机全部 worker 的管理能力。没有添加任意 URL、任意凭据或启动任意进程的参数。

### 本轮验收

- 新增 [taskResultDelivery 回归](packages/bush-runtime/test/taskResultDelivery.test.mjs)：15 项通过。覆盖 stop/inspect 在上下文提交前、回复期间与回复结束后的监听、上下文落盘失败后的补交付、并发新用户输入、普通父 Agent、状态查询、部分投影、取消、压缩恢复、执行尝试与父会话隔离。正常 stop/inspect 场景模型请求保持 4 次，不再从 4 次增加为 5 次；也不会创建多余执行状态。
- 新增 [worker 连接回归](scripts/test-worker-connections.mjs)：6 项通过。覆盖真实本地 HTTP 验证、失败回执脱敏、身份变化、健康检查、并发验证、重连与断开/移除竞争、App/CLI 宿主隔离、无能力时不注册、只读子 Agent 权限，以及过期验证的错误正文隔离。[本地 worker 回归](scripts/test-local-workers.mjs) 还通过实际 CLI Runtime 桥接执行了新工具的 verify/reconnect。
- 扩展运行时/远程回归共 412 项：首轮 411 项通过，1 项旧测试仍匹配已淘汰的英文错误句。核对基线源码已使用 `AGENT_DATA_DIRECTORY_BUSY` 后，将 [服务准入断言](scripts/test-agent-service.mjs) 改为验证该错误码；针对性复测通过，独占数据目录约束保留。
- `npm run test:ui-localization`（8 项）、`npx tsc --noEmit -p tsconfig.json`、`npm run build` 已通过。
- 补充的运行时与本机 worker 回归 304 项全部通过。加入过期请求的错误隔离后再次完成生产构建，并复跑任务交付、worker、SSH 隧道与 CLI 宿主专项，共 43 项全部通过。
- `npm run test:app-views`、`node scripts/run-settings-context-ui-test.mjs` 和 `node scripts/run-agents-ui-test.mjs` 通过，覆盖失败后刷新、状态与检查时间、语言切换、窄布局及主题。新增时间断言使用当前语言的 `Intl` 格式，兼容短年份显示。

本轮未调用生产 Remote53，也未修改其配置、凭据、隧道或运行任务。以下原始证据是历史快照，不能用来宣称当前生产服务健康，源码通过回归也不等于已部署生产。Web 综合套件已有的 6 项失败仍按原记录保留，不能将本次专项通过表述为整个 Web 综合套件通过。

## 对抗测试补充（2026-11-14）

围绕上述改动，使用隔离数据目录、确定性模型夹具和真实本地 HTTP 服务验证权限、取消、乱序回执与错误信息边界。没有读取生产凭据、访问 Remote53 或派发真实业务任务。

### 测试发现与架构修正

| 边界 | 修复前可复现的问题 | 当前处理 |
| --- | --- | --- |
| worker 操作准入 | 登记查询期间取消，查询返回后仍会开始验证或重连 | 查询后、宿主操作前重新检查取消状态；后续状态读取也检查调用生命周期 |
| Assistant / 实时工具取消 | 实时入口未传递取消信号，worker 管理操作脱离调用者生命周期 | Assistant、Runtime 与实时分发器向 worker 操作传递信号；停止后拒绝迟到回执。已受理的独立子任务保留独立生命周期，并验证其仍能完成 |
| 异常信息隔离 | 连接清理等意外异常未形成管理器失败状态时，可能原样返回错误文本 | 宿主边界返回受控错误码和已有语言包文案；状态读取失败同样隔离原始异常 |
| 批量任务控制 | 第一项停止操作触发取消后，仍继续调用下一项停止 | 每项控制前检查取消；保留已发生的真实操作，不执行尚未开始的后续操作 |
| 交付状态所有权 | 晚到的运行中/旧版本快照可覆盖终态；外部修改共享对象可能篡改待交付结果或使租约无法释放 | 同次执行按版本推进，终态不回退；状态持有独立快照，读取返回副本，租约固定任务标识并读取当前有效快照 |

修复位于操作准入、取消信号传递及任务状态生命周期；没有增加回复文本匹配、时间窗口或通知去重缓存。

### 对抗范围与结果

- 新增 [任务状态对抗测试](packages/bush-runtime/test/taskResultAdversarial.test.mjs) 和 [worker 对抗测试](scripts/test-worker-connection-adversarial.mjs)，合计 **20 项全部通过**。先复现上述缺口，再验证修正后的行为；测试夹具的受限服务在清理数据前关闭，避免清理顺序干扰结果。
- 交付侧覆盖伪造 JSON 回执、同会话与跨会话交付引用、历史重放、投影裁剪/替换、任务 ID/别名混淆、旧版本/同版本冲突、共享对象篡改、取消后旧租约提交。确定性随机序列覆盖 **4,096 次状态操作**，验证每个结果最多一个有效交付所有者，失效租约不能改变当前状态。
- worker 侧覆盖任意端点/凭据/命令参数注入、原型字段、未登记 ID、受限 Web 原始 API、子 Agent 白名单与只读限制、取消时序、迟到成功回执，以及意外异常中的合成凭据。
- 真实本地 HTTP 夹具覆盖同源和跨源的 301/302/307/308 跳转、401/500 原始错误正文、畸形 JSON，以及固定响应头下伪造响应体身份。跳转目标收到 **0 次请求**；错误回执未包含合成凭据，失败没有替换已固定的 worker 身份。
- 运行时、stop/inspect 交付、Assistant、实时入口、工具准入、worker、SSH 隧道、CLI 与 Web 远程专项共 **359 项通过**；凭据存储与本地 IPC 安全专项 **13 项通过**。新增对抗测试包含在 359 项内，不重复累计。增强独立子任务完成与同版本冲突断言后，20 项对抗测试再次全部通过。
- `npm run build`、`npx tsc --noEmit -p tsconfig.json`、`npm run test:ui-localization`（8 项）、`npm run test:app-views` 通过；文档 32 个本地链接与差异空白检查通过。

本次覆盖的边界内未再发现未修复的状态逃逸或权限绕过。该结果不等于对整个应用、所有第三方插件、远端服务或任意模型行为作无漏洞保证；也没有将独立子任务继续运行误判为取消逃逸。既有 Web 综合套件的 6 项基线失败仍按原记录保留，不能用本次专项通过替代完整 Web 验收。

## 原始排查一：此前提交已交付的改动

| 范围 | 已完成内容 | 主要入口与记录 |
| --- | --- | --- |
| Assistant 与普通会话的工具执行 | 派发立即返回终态时不再新增 Assistant 完成监听；同批 `summary_for_user` 等待其他工具结束；保留原始工具回执顺序和并发约束 | `packages/bush-runtime/src/assistantConversation.ts`、`runtimeToolLoop.ts`、`toolScheduling.ts` 及相关回归 |
| Assistant 动画角色 | 移除普通图片上传、静态头像覆盖分支及专用样式；侧栏、标题、欢迎页和设置统一使用动画角色；历史头像数据保留但不再读取 | `src/features/assistant/AssistantCharacter.tsx`、`AssistantSettingsDialogView.tsx`、[形象说明](src/features/assistant/art/README.md) |
| 网站组件 | 发布时声明允许的网站；提供组件内部的 `cardbush-browser` 原生网站视图，处理导航、尺寸、生命周期和失败；权限设置等操作收进菜单 | `src/features/components/ComponentBrowserViews.tsx`、`componentBrowsers.ts`、[组件规范](assets/skills/cardbush-docs/references/home-components.md) |
| 远程文件与 Web 媒体 | 委派输入附件、明确交付文件的传回、分块传输、版本与哈希校验；Web 图片、音视频和下载，支持 Range / HEAD | `electron/agentFileTransfer.mts`、`webFileResponse.mts`、[部署及验证记录](deploy/web/NAS-20261114-remote-media.md) |
| 远程提问 | 从真实远端任务恢复待答问题，按账号、会话和任务隔离，转发结构化回答，网页独立轮询 | `electron/webRemoteQuestions.mts`、`web/useConversationSolutions.ts`、[部署及验证记录](deploy/web/NAS-20261114-remote-questions.md) |
| 视频任务指引 | 区分回放切片、AI 生成和已有文件上传；准备商品图；成片交付后再进行用户确认与上传 | `assets/skills/auto-video-slicing/SKILL.md`、[分流记录](deploy/web/NAS-20261114-skill-routing.md)、[确认与回执记录](deploy/web/NAS-20261114-material-review.md) |
| 已部署版本回移 | 保留 NAS 旧版协议和模型契约的有限补丁、构建文件及回滚说明 | [Runtime 回移记录](deploy/web/NAS-20261114-runtime-loop.md)、`deploy/web/patches/` |

部署文档涉及的外部插件代码属于各自仓库；本提交包含本仓库已有的源码、指引、部署记录和补丁，不代表把外部仓库或生产数据一并纳入 Git。

## 原始排查二：停止子任务后重复回复

原始状态：**真实日志已确认，修复前构建已隔离复现。当前修复见上文。** inspect 的嵌套终态回执也已在本轮复现并纳入回归。

### 真实时序

用户先要求连接 Remote53，Assistant 派出本机子任务。随后用户说“不用了”：

| 时间 | 事件 |
| --- | --- |
| 17:53:21.758 | 用户发送“不用了”，进入新的前台轮次 |
| 17:53:24 左右 | `tasks(action="stop")` 已返回停止回执；`tasks[]` 中同一子任务为 `status="stopped"`，结果为空，错误为 `turn_stop_requested` |
| 17:53:25.367 | 原有完成监听将同一任务的 `stopped` 状态追加为内部 `background_task_result`，排入后续输入 |
| 17:53:30.990 | 前台轮次发布第一条回复“停了”，关联“不用了” |
| 17:53:33.215 | 后台结果另起一轮模型请求，发布第二条停止确认，关联原先的重连请求 |

这不是 UI 重复渲染，也不是停止工具执行了两次，而是同一终态经工具回执和后台通知两个入口被消费，额外唤醒了一次模型。

### 根因及此前修复的边界

- [AssistantConversation.watchDelegation](packages/bush-runtime/src/assistantConversation.ts) 只处理顶层 `taskId/status`，并在派发已返回终态时跳过新增监听。
- 本案第一次派发返回 `running`，任务已经进入 `watched`。后来 `tasks(stop)` 返回的是 `controls[] / tasks[] / after` 结构，没有将已返回的终态标记为已消费，也没有撤销旧监听。
- `schedule()` 每 1200 ms 检查已监听任务，看到非 running 状态便追加后台通知并设置 `pending`。本案通知在第一条回答生成期间入队，第一轮结束后继续 `pump()`。
- 现有 [teamCompletionAlreadyRead](packages/bush-runtime/src/teamResults.ts) 针对 `team_result` 及对应结果版本，不覆盖本案的单个子任务停止回执。
- 此前回归覆盖“派发立即终态”和真正的异步完成，未覆盖“先 running，后在另一个前台轮次用 tasks 读到停止终态”。因此此前修复有效，但覆盖范围不完整。

### 隔离复现结果

使用当前构建的 `AssistantConversation`，模拟派发、用户取消和 `tasks(stop)` 回执。没有调用外部模型或真实远程任务。

| 通知时序 | 通知前模型请求数 | 通知后模型请求数 | 多余请求 |
| --- | ---: | ---: | ---: |
| 第一条停止确认生成完毕后通知到达 | 4 | 5 | 1 |
| 第一条停止确认生成期间通知入队 | 4 | 5 | 1 |

两种情况均有 5 个不同的模型请求 ID，且出现“已停止”和“同一任务已停止”两条可见回答。计数中的前四次包括初次派发及其回复、停止工具调用及其回复；第五次才是多余请求。

### 最小修复方向与验收

1. 让派发、`tasks(stop)`、检查与等待等入口对“本轮已经返回给模型的终态”使用一致的消费记录。只有状态提示、尚未确认停止或结果未完整返回的回执，不能误判为已交付终态。
2. 消费终态后解除对应监听，并处理已经排队但尚未消费的同一完成通知；不能只在新增监听时判断状态。
3. 以任务及执行尝试/结果版本区分消费，不能永久按 task ID 屏蔽后续恢复执行的新结果，也不能全局丢弃 stopped 通知。
4. 回归同时覆盖上述两个时序、多个任务的部分停止、通知与新用户消息并发、同一任务恢复执行，以及未经同步消费的正常异步完成。
5. 验收标准是没有额外模型请求，且应交付的异步结果仍能到达；不以 UI 隐藏第二条回复或文本去重代替修复。

本记录不宣称普通会话的所有停止/等待路径都已验证无此问题；后续修改应检查共享任务消费入口并分别补足回归。

## 原始排查三：Remote53 连接状态被误判

原始状态：**当时服务和凭据已通过只读验证；状态表达和诊断路径需要改进。当前修复见上文。**

### 查证事实

- Remote53 登记为通过外部 SSH 转发访问的 HTTP worker，本机入口为 `127.0.0.1:14780`；该登记没有配置 CardBush 内置的 `sshTunnel`。
- 18:10:33 使用应用现有凭据解码与 `AgentHttpClient.info()` 发起只读请求，成功返回；服务身份与已登记身份一致，支持 delegation 及远程 worker 交互。解密材料和明文 token 仅在进程内使用，未输出到本记录。
- 此前诊断得到的 401 是子代理把配置中的加密 token 当作明文发送导致的。它不能证明服务端 token 过期或不一致。
- TCP 没有持续的 `ESTABLISHED` 连接，也不能单独证明 HTTP 服务不可用。

### 当前实现如何产生该状态

- [AgentConnectionManager.list](electron/agentConnections.mts) 的 `connected` 来自当前进程内的 `#live` 缓存，而不是每次列表读取时做一次远端健康检查。
- 桌面端 [agentConnections 初始化](electron/main.ts) 创建管理器；目录查询不会自动连接全部 worker。“未在本进程建立/验证连接”和“连接确实失败”都可能表现为 disconnected，单凭该布尔值无法区分。
- [运行环境快照](electron/main.ts) 当前只给模型 worker 的 ID、名称、connected 和 connectionState，未提供 connectionError、最近验证时间等诊断依据。
- [runRemoteSubagent](electron/remoteSubagent.mts) 真正派发时会先调用 `manager.connect(connectionId)`。已有合法身份的注册不要求仅因 disconnected 就先单独手工重连。
- 管理器中的周期健康检查和有界自动重试针对受管理的 SSH 连接。Remote53 的外部隧道 HTTP 登记不属于该路径；外部 SSH 进程也不是该管理器启动的。

建议把“未验证/按需连接”“正在连接”“连接失败”和“已验证”区分清楚，给模型提供最近检查及经过过滤的失败原因；不要让模型从缓存状态直接推断 token 失效、远端停机或必须重连。

## 原始排查四：模型可调用的 worker 验证/重连入口

原始状态：**当时底层和界面有能力，模型工具层缺少直接对应入口。现已补齐，见上文。**

| 层级 | 已有能力 | 限制 |
| --- | --- | --- |
| 桌面 IPC | `window.cardbushDesktop.agents.connect(id)` | 供桌面主窗口使用 |
| Team 远程连接界面 | [RemoteWorkers 的“验证连接”](src/features/team/RemoteWorkers.tsx) 调用上述 IPC | 模型没有相同的 worker 管理工具 |
| CLI | [cardbush worker verify ID](electron/workerCli.mts) 验证登记连接 | 是 CLI 自己的短生命周期管理器，不能等同于更新已打开桌面进程的连接缓存 |
| 派发宿主 | [remoteWorkers / remoteSubagent](electron/remoteWorkers.mts) 按需连接后操作 | 用于派发和已有子任务交互，不是单独的验证工具 |
| 管理 MCP | [reconnect_mcp_server](electron/productMcpManagement.mts) | 管理插件/独立 MCP 服务，不管理远程 worker；不能混用 ID |

本案子代理在被停止前完成的六次工具调用是三次工具检索，以及本机端口、进程、本地 HTTP 入口三次查询。没有调用 worker connect，也没有点击重连按钮。因此“已经做了六个动作，可能点过重连”的说法没有对应操作证据。

建议增加按已登记 connection ID 验证/恢复连接的受控宿主操作，复用现有管理器、凭据存储和身份检查，只返回经过过滤的状态与失败原因。不要要求模型自行读取凭据文件、猜测认证头、探测应用端口或启动额外隧道；也不需要为了这个缺口重构全部会话 loop。

## 原始排查五：此前验证记录与已知限制

此前本轮开发已经通过：

- `npm run test:ui-localization`（8 项）、`npx tsc --noEmit -p tsconfig.json`、`npm run build`。
- `node scripts/test-assistant-ui.cjs --character` 和完整 `node scripts/test-assistant-ui.cjs`：保留旧头像数据时验证 10 种动作、4 种表情、16 类道具，覆盖舞台提示、隐藏暂停、减少动态效果及设置行为。
- `npm run test:app-views`、`node scripts/run-settings-context-ui-test.mjs`、`node scripts/test-assistant-resident.cjs --profile`，包括个人资料头像上传与图片错误校验。
- 网站组件及远程功能的已有专项、部署版本验证范围见上表所链接记录。部署版本和当前开发工作区不是同一个版本，不可混用测试结论。

本次提交前补充检查通过：

- `node --test scripts/test-agent-file-transfer.mjs scripts/test-web-remote-questions.mjs`：13 项全部通过。
- `npm run build:web:ui`：Web 类型检查及生产构建通过。
- `node scripts/run-web-media-ui-test.mjs`：媒体元数据、播放和跳转通过。
- `node scripts/run-web-questions-ui-test.mjs`：空闲流中的新问题、自由文本只提交一次、会话隔离及恢复通过。
- 问题文档相对链接、非补丁文件的差异空白及待提交文件检查通过；凭据模式检查命中项均为测试中拒绝带凭据 URL 的虚构样例。四份部署补丁均通过 `git apply --numstat` 格式解析，补丁上下文空行必需的前导空格按原格式保留。

[远程提问部署记录](deploy/web/NAS-20261114-remote-questions.md) 已记载旧 Web 综合回归有 6 项基线失败，隔离基线同样失败；不能把新增专项通过写成整个 Web 综合套件通过。本次停止回执问题的隔离复现是确认缺陷的证据，也不能记为该问题已修复。

此前排查未改动 Remote53 配置、服务、token 或隧道，未执行重连、重启、业务派发或付费生成。后续源码修复及验收已记录在本文开头，生产部署仍需单独记录。
