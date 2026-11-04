# Friends 可行性验证综合报告

## 结论

**Friends 的核心事件驱动、自主执行闭环已在实验范围内跑通，可以作为接入 Cardbush 的机制依据。**

用户只设置 habit；Agent 自行创建事件、注册检测条件、选择资料来源与行动，在被唤醒后完成工具执行和实际终轮交付，并创建后续事件。检测程序常驻，等待期间没有新增模型调用。检测条件不携带预写的业务动作。

“闭环机制通过”和“新闻内容验收未通过”是两个维度。保留原始综合验收中的 `passed: false`，不把内容问题抹掉，也不把它解释为 Friends 机制不可行。没有开展 24 小时运行或真实多日耐久验证。

## 实际使用了哪些 Cardbush 能力

demo **复用了 Cardbush 内核中的执行组件**，外围增加了独立的实验模块。并非完全另写一个模型执行内核，也没有经过完整的 Cardbush 产品入口。

源码依据：[v5/friends-loop.mjs](v5/friends-loop.mjs) 的导入、`new InMemoryRuntimeHost(...)` 与 `runModelTurn(...)`，以及 [v5/main.mjs](v5/main.mjs) 的初始化和调度代码。

| 层次 | 实际实现 | 本次承担的职责 |
| --- | --- | --- |
| 模型与工具执行 | Cardbush `InMemoryRuntimeHost`、`ToolRegistry`、`createModelProvider` | 模型请求、工具续轮、执行终态；只有 Runtime 返回 `completed` 且存在实际终轮文本才继续交付 |
| habit 存储 | Cardbush `IndividuationStore` | 保存和读取预置 habit 及版本；本轮未开放自主修改 habit 的工具 |
| 环境感知 | 实验 `EnvironmentService`、`web-transport.py` | 目录事实、任务时钟、网页读取、来源版本和健康状态 |
| 事件与检测注册 | 实验 `EventRegistry` | Agent 自建工作事件、检测条件、版本约束、完成及产物证据 |
| 信号与常驻调度 | 实验 `Store`、`main.mjs` | SQLite 队列、去重、恢复、检测轮询、失败重试和模型预算 |
| 决策与交付 | 实验 `FriendsLoop`、报告账本 | habit/环境快照、通用系统提示词、工具集合、终轮落盘及重复交付防护 |

Runtime 使用服务器的 `1.0.14-20261102-1549` 发布目录。demo 明确关闭 `durableSessions`、`durableCoordination`、`durableSubagentTasks` 和默认工作区工具；实验自己的 SQLite 保存跨激活状态。每次激活输入新的环境与 habit 快照，没有用户对话输入。完整 App 的交互入口、所有生产工具和所有可靠性能力并未接入。

## 已取得的证据

| 场景 | 输入与时钟 | 结果与边界 |
| --- | --- | --- |
| v4 | 一条 NBA habit；合成目录资料；两个加速模拟日 | 8 项基础测试、27 项场景检查通过；验证目录变化、重启恢复、到点交付、去重及下一日衔接；不是真实两天测试 |
| v5 live-01 | 一条 NBA habit；真实时钟与网页 | 到点自动触发，但取材反复失败，无终轮；保留失败记录 |
| v5 live-02 | 新实例 | 观察程序在 heartbeat 出现前退出，尚无模型激活；不计作完整 Agent 试验 |
| v5 live-03 | 一条 NBA habit；真实时钟；自行找来源 | 16/16 执行链路检查通过，18 次模型请求、2 次激活，用户信号及 provider `user` 角色消息均为 0；内容复核未通过 |

v5 最终实例在北京时间 17:46:53 启动，17:48:53 到点，17:50:11 产生真实终轮。之后观察 30 秒，没有重复交付或新增模型请求，再停止服务。触发的是 habit 规定的阅读时刻；没有虚构两分钟后必定发布的新闻。Agent 已登记次日事件，但停服后未执行。

关键记录：

- [v4 检查与统计](v4/verification.json)、[v4 场景结果](v4/runs/nba-01/test-results.json)。
- [v5 16 项执行检查](v5/runs/live-03/mechanical-test-results.json)、[最终审计记录](v5/runs/live-03/audit.json)。
- [模型实际终轮](v5/runs/live-03/latest-final-reply.txt)、[内容复核](v5/runs/live-03/semantic-review.json)、[原始综合验收](v5/runs/live-03/test-results.json)。
- [首次失败记录](v5/runs/live-01/test-results.json)、[首次采集器源码](v5/versions/initial/web-transport.py)。

## 自我修正的实际边界

已经观测到的是：v4 遇到 `STALE_EVENT_REVISION` 后重新读取事件状态并恢复；v5 在网页不可读时自主更换来源；v4 根据更正资料更新摘要。这些是有工具或环境反馈的执行修正。

尚未实现的是：自动发现本次终轮中的时区错误、把内容校验失败送回 loop、修正后再次校验，以及从环境反馈自动形成或更新 habit。v5 把已提供的 UTC 时间误当美东时间，北京时间因此晚了 5 小时；工程师在两轮之间修复采集器、人工复核终轮，均不计为 Agent 自我修复。

实验外围较简化、交付前缺少语义校验是可以确认的事实；“内容错误完全由一次性架构导致，换回完整 Cardbush 就会消失”没有通过对照实验验证。复用现有 Runtime 也不等于自动获得新闻事实校验。产品接入时应为来源时间标准化、交付约束校验和可恢复反馈补上明确的实现与验证。

## 接入 Cardbush 时的落点

可以沿用现有模型执行、工具注册和 habit 存储，把环境事实、持久事件、检测注册及信号队列作为独立能力接入。信号负责唤醒，行动和交互仍由 Agent 根据 habit 与环境决定，避免把新闻流程写进框架。

需要继续设计：真实用户活动感知的来源与授权；事件/检测的生产持久化及恢复；内容校验失败后的反馈与修正；终轮到现有用户界面的交付。用户可见的核心配置保持为 habit 和事件，内部检测器与队列不要求用户配置。

本次没有验证桌面行为理解、真实突发新闻的 HTTP 变化触发、habit 自动学习或长期无人值守稳定性。v5 真实场景选择的是时钟检测；HTTP 注册只有基础测试证据。上述边界不影响本轮“先证明链路能成立”的结论。
