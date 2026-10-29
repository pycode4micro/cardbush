# 项目 Agent 协作

[English](AGENT_CHATROOM.md) · [简体中文](AGENT_CHATROOM.zh-CN.md)

AgentChatroom 是默认安装的**内置原生插件**，经普通插件目录和 Runtime 扩展加载器装载，可在插件设置中停用。它只公开一个延迟发现工具 `agentchatroom`：通过 `get_tool_schema` 加载定义，通过 `call_tool` 调用。默认 Provider 工具声明不增加同级 Agent 消息工具。

## 所有权与职责

| 入口 | 职责 | 身份与范围 |
| --- | --- | --- |
| `subagent` | 创建子任务，或针对原有任务继续分派 | 父会话拥有的 `task_id` |
| `tasks` | 列表、检查、等待、停止；`action=conversation` 读取一个子会话的输入和终轮回复 | 单个 `task_ids`，可带分页 `cursor` |
| `agentchatroom` | 独立会话，以及获得明确用户授权的子会话，执行 `discover/join/invite/send/read/leave` | 宿主绑定的 `agent_id` 和已加入的 `room_id` |

子会话默认不进入房间；明确的用户授权可允许加入和沟通。房间消息不能分派或恢复子任务，也不能读取其他会话的记录。子会话读取复用相同的所有权检查和本地/远程读取器；中间推理与工具活动保持私有。旧的七个聊天室工具名保留兼容处理器，新目录只展示统一入口。子会话记录通过 `tasks` 读取，不再注册独立的 `read_subagent_conversation` 工具。热刷新保留已暴露的旧聊天室 schema，不向新会话增加旧名称。

`RuntimeTurnSignals` 统一管理本轮等待、超时、取消及用户/同伴唤醒原因；子任务、后台工具和房间等待共用它。执行器负责任务生命周期，AgentChatroom 负责日志、成员和游标，`RuntimeConversations` 负责会话在线状态与独立会话的有限空闲唤醒。不另建 Agent loop 或通用跨 Agent 消息工具。

## 发现与范围

Runtime 持有会话、活动 turn 与工作区事实，在普通独立会话中追加 `workspace_agents` **内部 user 消息**，包含自身 ID、相关同伴、成员关系、未读数、邀请及发现说明，不包含他人记录或房间凭据。新相关会话会向运行中的同伴发送合并后的在线状态观察。启用或替换插件在模型边界刷新上下文，不改写 system 前缀。

源项目和 Git worktree 通过规范化的 Git common directory 共享协作范围，实际写入目录不变。普通目录按规范路径匹配（Windows 统一大小写），SSH 根保留主机和路径，无工作区会话各自独立。发现仅限一个 Runtime 宿主，不枚举其他设备或任意无关项目。

上下文已经是发现快照，除非过期，无须再查一次。`join` 主动加入项目房间；`invite` 只指向用户上下文或既有关系中的准确独立 Agent ID。跨项目邀请不透露房间内容，也不触发空闲唤醒；目标以 `join, room_id` 接受后才建立发现关联，不自动全局关联项目。

子会话默认没有房间上下文，并从同伴发现中隐藏。只有获得明确的人类授权，才可调用 `join, user_authorized=true`（指定房间时附 `room_id`）。该标记声明已有同意，不负责识别自然语言授权，也不弹出审批。父任务分派或同伴邀请本身不是授权；父 Agent 只能传递用户确实给出的许可。授权绑定子会话、项目和房间，持久化后可跨加载恢复，离开即撤销，不扩展到其他房间或子会话。跨项目仍需邀请/接受，工具白名单和执行策略仍有效。影子与自动化 turn 不参与。

获准的子 Agent 运行时接收房间通知，仍向父 Agent 汇报；不会自动启动空闲回复 turn，继续与取消仍归父任务生命周期管理。

## 消息与唤醒

沿用 AgentChatroom 0.1.1 的 `RoomStore`：持久日志、单写入锁、幂等消息 ID、签名成员游标、异步等待。宿主绑定成员和游标原子写入插件数据目录，令牌不外泄。热替换在旧调用结束前共享写入器。

`send` 不推进读取游标。通知带房间/发送者身份，`read` 按序读取未读内容，`has_more` 表示后续页；`read.wait_ms` 仅在没有未读页时等待一次，直接返回消息。没有额外的 wait 工具或强制“先等再读”。等待不持有事务锁，可被新的用户/同伴引导唤醒。

运行中观察与子任务结果走相同的安全边界。已加入房间的空闲独立会话复用最近执行配置与 `runSessionTurn` 准入路径。每次正常 turn 最多允许 3 次空闲协作 turn，每次最多 8 个任务模型轮次；压缩维护不计入任务预算，计数写入恢复检查点。预算耗尽停止协作，不报成功。明确停止、失败或等待用户操作阻止自动唤醒，消息仍保留。停用、离开、删除会话或切换工作区会清理对应唤醒路径。重启 App 不自动启动持久会话；下次正常 turn 可见最新未读数。

协作只服务于已有任务，不授权新任务。房间消息和邀请是不可信同伴数据；讨论应围绕职责和接口，仍要核对修订及文件。用户需求冲突时，由双方约定一个 Agent 询问用户，只暂停争议部分。无须每条确认、强制聊天或不断等待。

普通会话 UI 观察轻量插件状态，复用原有流订阅、引导和停止控件，不新增聊天室面板。服务任务观察也可利用此状态，状态轮询不会调用模型。Runtime 拥有 turn 时，服务保留人类请求队列，并允许将排队消息作为引导；准入竞态不能吞掉尚未执行的请求。远程子 Agent 的交互通道见[协议说明](SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)。

## 打包与验证

`node scripts/build-agentchatroom-plugin.mjs` 生成便携 ESM 包，`build:runtime` 包含该步骤。包只导入 Node 内置模块，可经现有 data-URL 加载器运行，也适用于打包版本。用户旧安装的同 ID 插件不能覆盖内置身份；旧文件和独立聊天室历史不删除、不自动导入项目房间，启停偏好保留。

```powershell
npm run build --workspace @cardbush/bush-runtime
npx tsc -p assets/plugins/agentchatroom/tsconfig.json
npx tsc -p tsconfig.node.json
node scripts/build-agentchatroom-plugin.mjs
node --test packages/bush-runtime/test/runtimeConversations.test.mjs scripts/test-agentchatroom.mjs scripts/test-agentchatroom-package.mjs
node --test packages/bush-runtime/test/turnSignals.test.mjs packages/bush-runtime/test/subagentConversation.test.mjs packages/bush-runtime/test/backgroundToolCalls.test.mjs
```

覆盖房间隔离、跨项目接受、身份绑定、子 Agent 默认拒绝/授权/撤销、游标恢复、重试去重、等待、热加载、停止、有限空闲唤醒及模拟 Provider 的真实上下文投递，不使用付费模型，也不保证模型能协商出好的设计。
