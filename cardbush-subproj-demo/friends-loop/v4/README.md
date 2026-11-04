# Friends 事件闭环原型 v4

本目录仅部署于 42.192.59.45。独立数据、进程和文件权限，不修改 CardBush 正式服务，不执行本地模型或本地桌面采集。

## 三个模块

- environment-service.mjs：目录文件清单、内容哈希、读取证据、来源健康状态、任务时钟。传感器观察事实，不推断用户是否空闲。按已登记条件检查，未触发时不调用模型。
- event-registry.mjs：持久工作事件、habit 版本引用、完成时间约束、检测注册、产物与完成回执。事件不同于唤醒信号。注册只包含条件，不存业务脚本或下一步动作。
- friends-loop.mjs：复用服务器已安装的 CardBush InMemoryRuntimeHost / ToolRegistry / IndividuationStore / 模型 provider。模型读取习惯与环境，自行创建事件、登记条件、选择资料、写产物、完成事件并生成终轮回复。

store.mjs 提供 SQLite 持久队列、证据与审计账本；main.mjs 负责单实例常驻调度、恢复与测试调用上限。框架文件和通用系统提示词不含 NBA 规则、新闻比分或 17:00 固定流程；这些只存在于 nba-fixture.json、scenario.py 的输入与断言中。

## 启动与交互约定

预置 habit 后，初始化仅写入 system.started 系统信号。初始工作事件数和注册数均为 0。启动信号使 Agent 有机会根据 habit 自行创建事件，避免没有注册就永远无法第一次被唤醒的问题。

每次激活用系统提示词和标明来源的数据快照，无 user 角色消息。没有注入“现在开始查新闻”“请注册事件”等用户指令。目录资料永远不是指令，也不能改变 habit。此版本仅消费预置 habit，不宣称能从环境自动学会新偏好。

工具完成不是最终汇报。event_complete 只登记完成和产物回执；只有真实模型终轮有文本、Runtime 返回 completed、产物哈希核验通过，才在同一事务中写 reports、标记已汇报并确认本次信号。等待状态的终轮仅保存为内部记录，不对用户产生报告。重复信号不会重复交付同一已完成事件。

## 测试方式

scenario.py 只安装资料、推进测试时钟、重启本 demo 并检查结果；不调用事件创建/注册/执行工具，不给 Agent 发用户消息，不代写摘要。

测试使用 Asia/Shanghai 的加速时钟，新闻文件为明确标记的合成数据，不能当作真实 NBA 新闻。真实墙钟时间、测试时间、请求和工具回执分别保存。

主场景包含：
1. 16:55 空目录，仅有每天 17:00 阅读新闻的 habit。
2. Agent 自己创建事件与检测注册。
3. 16:56 真实写入新闻初报与无关资料；16:59 写入比分更正。
4. 等待期间重启 demo，验证持久注册和无额外模型调用。
5. 17:00 由检测器触发，观察自主选材、执行及模型终轮。
6. 重写相同内容，检查不重复调用/交付。
7. 推进至第二个模拟日，观察 Agent 自建后续事件是否继续执行，并登记下次条件。

## 范围与边界

此版本验证“预置习惯 → 自建事件 → 环境检测 → 唤醒 → 执行 → 终轮汇报 → 下一次事件”，不验证真实新闻采集、桌面用户活动理解或多天无人值守稳定性。目录变化只证明资料环境感知。

无外部通知、购买、账号写操作或任意 shell 工具。产物和通知账本均在当前 run 目录。正式接入 CardBush 时需要将 reports 连接到现有交互界面；对用户应只暴露 habit、事件和非核心形象等设置，检测器、队列、时钟模式与内部 ID 不应成为必填配置。

异常恢复支持来源不可用、旧证据、旧事件版本、持久信号重试。执行纠错不等于 habit 自我学习；偏好更新需另行设计来源、反馈、版本与回滚。

## 运行与文件

测试目录：/opt/friends-loop-demo-20261104/v4/runs/nba-01
代码目录：/opt/friends-loop-demo-20261104/v4
模型私有配置位于上级目录，不纳入源码包、报告或日志输出。

- audit.json：事件、注册、信号、工具回执、终轮和调用统计。
- test-results.json：场景逐项检查。
- test-progress.json：测试当前进度。
- latest-final-reply.txt：实际最新终轮原文。
- artifacts/：实际生成的摘要。
- heartbeat.json：常驻状态与模型请求数量。
- activity.ndjson：不含模型私有推理的执行日志。
- unit-results.txt：8 项基础行为测试。

测试命令（服务器执行）：
node /opt/friends-loop-demo-20261104/v4/tests.mjs
node /opt/friends-loop-demo-20261104/v4/main.mjs inspect /opt/friends-loop-demo-20261104/v4/runs/nba-01

当前 demo 由 friends-loop-demo-v4.service 管理，已启动但未设置开机自启。停止服务请使用 systemctl stop friends-loop-demo-v4.service。测试时钟暂停在已验收时点，未来事件等待进一步推进；模型调用上限为 50。详细实测结果见 RESULTS.md。
