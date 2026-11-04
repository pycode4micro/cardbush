# Friends 真实短场景测试结果

结论：真实时钟、真实网络来源和自主事件执行闭环已跑通；内容质量复核未完全通过。整体结果不得标记为全通过。

用户已取消 24 小时运行。测试均在 42.192.59.45 的独立目录与服务完成，无本地模型/测试/代码修改。所有测试服务现已停止，正式 CardBush 服务仍为原进程。

## 场景与原始输入

仅预设一条 NBA 阅读 habit；无来源 URL、新闻内容、事件、检测注册或用户消息。触发的是指定的真实阅读时刻，不是虚构某场比赛或新闻发布必定在五分钟后发生。

首轮 live-01：17:33:49 初始化、17:38:49.054 自动触发（54ms 延迟），随后取材反复失败，没有终轮。搜索相关性差、读取器不附标题链接对应、脚本页面缺少明确不可读状态，是这次实际暴露的工具问题。保留原始版本与失败记录。

中间 live-02：只读观察程序在 heartbeat 尚未创建时提前退出并停止服务；尚无模型激活或事件，不计作 Agent 完整试验。已修复观察程序的启动等待。

修正采集工具后，live-03 使用全新数据库及同类 habit，将首次阅读安排在启动后两分钟。没有给运行中的 Agent 补发指令，也没有人为替它选择来源或代写摘要。

## 最终实例时间线（北京时间）

- 2026-11-04T17:46:53.875+08:00：system.started
- 2026-11-04T17:48:53.182+08:00：clock.reached
- 2026-11-04T17:50:11.756+08:00：actual_final_reply

实际终轮形成后再观察 30 秒，未重复汇报、未增加模型请求，17:50:42 左右停止测试服务。Agent 已自行建立次日 17:48:53 的后续事件，该事件保留在数据库，但服务已停，不会继续执行。

## 已验证

13 项基础/采集测试通过；16/16 执行链路检查通过。真实模型共 18 次请求（2 次激活），用户信号和 provider user 角色消息均为 0。等待期间没有新增模型调用。

Agent 自主搜索，尝试 NBA 中国官网、ESPN 等网页；发现不可读后转向可读来源，最终读取 NBA.com 原文和虎扑比赛中心，写出实际产物、完成事件、提交真实终轮并登记次日事件。最终实例没有失败的激活。

本次 Agent 选择的是时钟检测，没有选择 HTTP 变化注册；因此本次真实验收证明时间事件驱动，不能据此宣称已验证突发新闻变化自动触发。

## 内容复核失败项

三篇文章结构化元数据已把发布时间标成 UTC（Z），且实际提供给了 Agent。但 Agent 将网页显示时间当成美东时间再换算，导致北京时间统一晚了 5 小时。例如：

- 2026-11-03T04:18:11Z 正确为 2026-11-03T12:18:11+08:00；来源：https://www.nba.com/news/5-starters-1-sub-pacers-down-to-6-players-for-game-against-atlanta-because-of-injuries-rest
- 2026-11-04T01:17:21Z 正确为 2026-11-04T09:17:21+08:00；来源：https://www.nba.com/news/kawhi-leonards-knee-swelling-has-been-treated-and-hell-start-return-to-play-process-raptors-say
- 2026-11-03T15:44:27Z 正确为 2026-11-03T23:44:27+08:00；来源：https://www.nba.com/news/starting-5-november-3-2026

赛事与伤病摘要可在实际读取原文中找到依据；时间换算错误仍属实质问题。简报也偏长：三个栏目中含四场赛果、两条伤病及额外交易说明。

原始终轮和产物未篡改，保存在 runs/live-03/latest-final-reply.txt 与 artifacts/。校正结果仅写在 semantic-review.json；没有冒充 Agent 自己修好了这些错误。

## 下一步应补的机制

环境模块提供带来源的标准化绝对时间及用户时区显示值，避免模型自行猜时区；交付前校验日期和条数，校验失败成为可恢复的反馈信号，再由 Agent 修正。当前证据不足以宣称内容自纠错已经可靠。

## 当前状态

正式服务：
MainPID=1480462
ActiveState=active
SubState=running

测试服务：
MainPID=0
ActiveState=inactive
SubState=dead

审计入口：runs/live-01/test-results.json、runs/live-03/mechanical-test-results.json、runs/live-03/semantic-review.json、runs/live-03/test-results.json、runs/live-03/audit.json。
