# 远程 worker 与子 Agent 交互

远程服务是执行子任务的 worker，主助手仍在当前宿主。当前源码实现实验性的 `subagent-remote-proton` 0.1，以 CardBush HTTP 绑定传输。接入方式学习 MCP 的客户端/服务能力注册，执行继续复用已有子 Agent；当前并未实现 MCP 线上兼容，也不保证任意第三方 Agent 已能互通。已发布 npm 1.0.13 不包含这次迁移。

## 注册

1. 依照[部署指南](agent-deploy.md)启动服务，保留其独立模型、工作区、配置和权限。使用 HTTPS 或经过鉴权的 SSH，核对持久实例 ID。
2. App 在 Team 的员工页添加远程 worker；CLI 使用 `cardbush worker add --name NAME --url URL --token-file PATH`，再用 `cardbush worker list` 和 `cardbush worker verify ID` 检查。令牌内容不能进入模型上下文或聊天。验证失败保留已有连接 ID，显式重试，不重复创建。
3. 发现当前宿主实际提供的子 Agent 注册能力；从 `list_subagent_options` 返回的连接与实例信息保存具名角色，包含职责和 `remote: { connection_id, agent_id }`。角色名应说明工作用途。不要猜 ID，不复制父会话全文、模型密钥、浏览器授权或工具清单。
4. 远程角色不接受本地 `allowed_tools`、settings、hooks、guards。远端工具、策略由远端宿主执行。App 和 CLI 连接库暂时独立，在实际执行父任务的一端注册。

## 对话与任务

协议只定义交互语义，不要求另一端使用 CardBush 的工具名。当前 CardBush 适配复用 `subagent` 和 `tasks`，先读取实际 schema：

- 新任务携带自足的文字要求与已注册角色；返回任务 ID 后保留它，作为等待、追加、回答、停止的归属依据。
- `queue` 是同一子会话的下一轮；`insert` 是指定活动任务下一安全边界的引导，不打断已派发工具。过期的 insert 不自动变成新任务。
- 等待只观察状态、简短进度和待回答事项，不启动额外模型轮次。保留游标，避免反复查询或重发任务。
- 子 Agent 可以用文字询问父 Agent；父 Agent 向原任务的 `interactionId` 回答。选项只是建议，自由文本有效，不必伪造一个操作指令。
- 停止请求与远端确认分开。`unavailable` 表示无法确认，不能报告已停止或已完成，也不能自动另起重复工作。

## 授权与恢复

问题回答不是授权。权限请求由远端提供动作摘要、范围、digest 和决策类型；只能对同一待处理事项提交结构化决定，不能用“同意”文本、伪造人类身份或修改范围获得权限。默认 `human_required` 需远端所有者的受信任界面处理；父模型不能代批。管理员明确启用 parent delegation 后，也只允许当次已绑定范围的决定。

父任务申请的权限与远端 `CARDBUSH_REMOTE_PERMISSION_MODE` 上限取交集。即使全权限，宿主 required 沙箱、操作系统限制和进程保护仍生效。现有服务 token 属于实例所有者凭据，不是隔离的子任务令牌；不要交给不可信 Agent。注册不授予子 Agent 互相通信或无限递归分派能力。

网络恢复保留任务、消息 ID 和游标，有界重试；永久鉴权或身份错误需要修复。`outcome_unknown` 表示回执不确定，先查询原任务，不换 ID 重试副作用。当前预览不自动恢复父进程重启前的交互观察器，不提供跨主机人类身份委托或自动文件传输；远端路径不是本机文件。
