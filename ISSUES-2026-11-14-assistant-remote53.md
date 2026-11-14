# 2026-11-14 改动汇总与 Assistant / Remote53 问题记录

本文件随当前工作区的全部改动一起提交。下列“已完成改动”和“待修复问题”必须分开理解：本次最新排查确认了新的结果消费缺口，并未在本次提交中修复该缺口，也未新增 worker 连接管理工具。

时间均为北京时间（UTC+08:00）。诊断只读取真实记录和服务信息，复现使用模拟模型与隔离临时目录；生产会话、凭据和完整工具日志不收入仓库。

## 一、随本次提交交付的已有改动

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

## 二、待修复：停止子任务后重复回复

状态：**真实日志已确认，当前构建已隔离复现，尚未修复。**

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

## 三、待改进：Remote53 连接状态被误判

状态：**当前服务和凭据已通过只读验证；状态表达和诊断路径仍需改进。**

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

## 四、待补齐：模型可调用的 worker 验证/重连入口

状态：**底层和界面有能力；模型工具层缺少直接对应入口，尚未补充。**

| 层级 | 已有能力 | 限制 |
| --- | --- | --- |
| 桌面 IPC | `window.cardbushDesktop.agents.connect(id)` | 供桌面主窗口使用 |
| Team 远程连接界面 | [RemoteWorkers 的“验证连接”](src/features/team/RemoteWorkers.tsx) 调用上述 IPC | 模型没有相同的 worker 管理工具 |
| CLI | [cardbush worker verify ID](electron/workerCli.mts) 验证登记连接 | 是 CLI 自己的短生命周期管理器，不能等同于更新已打开桌面进程的连接缓存 |
| 派发宿主 | [remoteWorkers / remoteSubagent](electron/remoteWorkers.mts) 按需连接后操作 | 用于派发和已有子任务交互，不是单独的验证工具 |
| 管理 MCP | [reconnect_mcp_server](electron/productMcpManagement.mts) | 管理插件/独立 MCP 服务，不管理远程 worker；不能混用 ID |

本案子代理在被停止前完成的六次工具调用是三次工具检索，以及本机端口、进程、本地 HTTP 入口三次查询。没有调用 worker connect，也没有点击重连按钮。因此“已经做了六个动作，可能点过重连”的说法没有对应操作证据。

建议增加按已登记 connection ID 验证/恢复连接的受控宿主操作，复用现有管理器、凭据存储和身份检查，只返回经过过滤的状态与失败原因。不要要求模型自行读取凭据文件、猜测认证头、探测应用端口或启动额外隧道；也不需要为了这个缺口重构全部会话 loop。

## 五、验证记录与已知限制

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

最新排查未改动 Remote53 配置、服务、token 或隧道，未执行重连、重启、业务派发或付费生成。后续应按以上待修复项修改和验收，再更新本文件的状态。
