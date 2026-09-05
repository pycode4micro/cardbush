# UI / Runtime 架构审查（2026-09-05）

## 后续实施：三项边界修复已完成

在用户确认后，完成了本报告原先列出的三个后续项：

1. **上下文用量新旧响应保护**：按会话维护本地读取票据。新请求、实时用量、Turn 开始/结束使旧读取失效；有效请求仍去重。运行中不使用未提交的历史覆盖实时用量，不比较 token 大小，因此压缩后的下降正常。删除会话也使未完成读取失效。
2. **失效订阅回收**：main 同步清理 worker 的具体 subscription，监听真实导航提交、renderer 崩溃与销毁；只尝试而未提交的导航保持连接。清理旧文档时按订阅实例匹配，不能取消新订阅。启动等待期间销毁也会在启动完成后补做收尾。stop_stream 不会启动已停止的 Runtime，也不会投递给替换进程；未使用 cancel_operation / stop_turn。
3. **历史读取与 live 投影协调**：在读取入口捕获会话票据和该会话的消息数组引用，写入时再核验，保护尚未 render 的已排队状态更新。初次加载、手动刷新、goal 轮询、流结束读取、故障恢复、编辑前读取共用保护；普通历史不覆盖运行中内容。原消息合并、停止终态校准、supersession 和存储协议保留。已确认的当前 Turn 终态恢复仍可对账。并发加载按请求计数，旧请求结束不清除新请求的 loading。

新增/扩展验证：

- `test-session-read-fences.mjs` 从实际 hook 中抽取回调，使用可控 Promise 与排队 state updater 测试响应乱序、跨 Turn、压缩下降、跨会话、删除、未 render 的实时更新、停止归档、替换消息和并发 loading；没有复制生产回调实现。它不是整页端到端 UI 测试。
- `test-runtime-host-lifecycle.mjs` 增加订阅归属、重复身份、取消导航、提交导航、新旧订阅隔离、send 失败、启动期间销毁、崩溃和注销测试。
- 真实 Electron + Utility Process 测试增加 quiet subscription 重载/窗口销毁验证；无需等待新 stream frame 也能回收。
- Runtime 增加“订阅中断 → 原 Turn 继续 → cursor 重接 → 单次终态与单次归档”的行为测试，Provider fixture 的请求计数仍为 1。主包 204/204 通过。
- 后续补丁最终回归：48/48 契约检查、Runtime Client、标签 Electron 行为、UI/后端类型检查与 Vite production 构建通过。构建仍保留原有大 chunk 警告。

这次没有调用真实收费 API：缺陷发生在本地读取/订阅时序，使用确定性的延迟注入和真实 Electron IPC 能直接覆盖；没有改 Provider 请求或真实用户会话数据。以下保留初次审查记录，便于追溯。

## 范围与结论

基于 `7919462` 及本地尚未提交的标签管理改动，检查 UI → 客户端投影 → Electron IPC → Utility Process → Runtime → 持久化的关键链路。

本次修复了三个标签交互缺陷、两个 Runtime 生命周期/取消错误，并修复一个集成测试提前退出的漏洞。没有修改模型请求、压缩策略、cache chain、工具结果或历史归档语义；没有调用收费模型，没有提交或推送 Git。

这是关键链路的横向代码审查与自动化验证，不是所有主题、文件格式、供应商和用户操作组合的穷尽测试。通过的测试不能证明整个产品没有其他 bug。

## 已修复

| 问题 | 原因与处理 | 验证 |
| --- | --- | --- |
| 右键菜单偏移/被裁剪 | 菜单在带 transform 的 inspector 内使用 fixed + 屏幕坐标。改为 portal 到 `.app`，保留主题变量并脱离面板裁剪。 | Electron 检查菜单实际坐标和可点击区域 |
| 首次打开/重开后标签滚动失效 | presence 延迟挂载，但原 effect 只依赖逻辑状态，执行时 ref 为空。抽出 `useInspectorTabStrip`，callback ref 跟随真实 DOM 绑定/解绑。 | 延迟挂载、关闭后重开、新增活动标签 |
| 滚轮无法阻止默认滚动 | React wheel 是 passive，原 `preventDefault()` 无效。改为原生非 passive 监听，保留 Ctrl/Meta 缩放，处理像素/行/页单位。 | WheelEvent 默认行为取消、位移恰好一次、Ctrl 不拦截 |
| Runtime 快速重启串扰 | 旧进程的迟到 exit 会清掉新进程引用并拒绝新请求；旧 message/error 也可能影响新请求。事件按进程实例隔离；stop 立即结算旧 pending 请求。 | 进程替身故障注入：旧 error、伪同 ID response、exit 都不能污染新进程 |
| 取消 IPC 失败产生未处理异常 | abort listener 发起的 cancelOperation/stopStream Promise 没有 rejection handler。取消旁路做 best-effort 收尾，结果仍由原命令/流报告。 | 注入两种 IPC rejection，确认无 unhandled rejection，原命令结果仍保留 |
| 集成测试提前退出、后续断言未执行 | 关闭唯一测试窗口后 Electron 可能提前结束。测试进程接管 window-all-closed，完成重启/历史恢复断言后显式退出。 | 实际收到 `Electron Utility Runtime Host contract passed.` 完成标记 |

标签 hook 还改为只滚动标签条本身，不再使用可能带动祖先的 scrollIntoView；溢出判断使用包含箭头位置的完整条宽，避免窗口变宽后箭头自身导致“永久溢出”。

此前文件点击闪动优化中的稳定 pathAliases 与回调引用保留。本次没有通过完整真实会话录像复验该闪动，不能据此保证所有闪动来源都已排除。

## 仍需跟进的发现

### P2：历史用量请求可能覆盖实时用量（代码路径风险，未做完整 UI 复现）

`src/hooks/useCardbushChat.ts` 的 `refreshMeasuredContextWindowUsage` 与 `mergeContextWindowUsage` 都直接覆盖同一 session 的用量。按 session + turn 的请求去重只避免重复发起，不能阻止迟到的历史响应覆盖它发出后收到的实时 model-request 用量，也不能协调不同 turn 的请求先后。

建议：为用量写入增加按 session 的版本/请求序号保护，先补“历史读取开始 → 新实时事件 → 旧读取完成”的延迟注入测试。不要修改 token 定义或用比例 clamp 掩盖问题。本次未改这条链路，以免与已有重放和压缩统计规则混杂。

### P2：失效 renderer 的订阅回收不完整（代码已确认，影响大小待运行验证）

`electron/runtimeHostController.mts` 的 stream frame 转发在 frame 失效/导航/send 失败时仅删除 main 的 subscription 映射，没有同步向 worker 发出 stop_stream。`electron/runtimeHostWorker.mts` 的订阅要等终态、错误或显式 stop 才结束。长时间运行或无新事件的 Turn 中，失去接收者的 worker 订阅可能继续保留。

这不等于模型执行重复，也不应通过停止用户 Turn 解决。后续应单独实现 renderer/frame 生命周期绑定的订阅取消，并测试“取消订阅不停止 Turn、重连从 cursor 重放”。本次没有把它与进程实例隔离混成一个大改动。

### P2：异步历史刷新与 live 投影仍缺少统一的新旧判定（待复现）

`refreshActiveSession` 拉取后使用 `mergeLoadedMessagesPreservingLocalState` 合并。合并器主要以 loaded 为准，只特别保留缺失的 stopped/failed terminal assistant；并没有统一保留历史快照之后新增的运行中消息。普通会话切换的首次读取有 cancelled 防护，但不能推导所有刷新入口同样安全。

建议用延迟历史读取 + 同时开始新 Turn 的测试核实，之后以运行代次或 snapshot revision 判定新旧，而不是继续堆文本或消息数量判断。不能根据这段代码就断言它是此前具体会话丢渲染的根因。

### P3：测试和模块边界的维护风险

- 部分契约测试绑定变量名/代码顺序：本次修正了 `freezeStopped` → `freezeTerminal`、onDone 增加清除重试状态、预览窗口改为 inspector 路由、loading 增加 history 参数后的过期断言。没有移除停止后的工具顺序、只读预览和双语等行为要求。
- 原生 Computer Use 测试受真实用户输入影响；终端测试曾在并发负载下晚于其固定等待时间退出。需要将纯 Unicode/状态断言与真实桌面集成测试分层，不应关闭用户活动保护来让测试通过。
- `App.tsx` / `useCardbushChat.ts` 承担较多状态协调，存在三套相似的流事件处理路径。后续宜逐步提取公共投影/生命周期边界，本次仅抽出独立标签 hook，没有大规模重构。
- Vite 构建仍提示大于 500 kB 的 chunk（包含文档解析器）。这是性能预算项，不是此次标签/重启故障的证据。

## 覆盖的架构边界

| 边界 | 检查内容 | 本次结论 |
| --- | --- | --- |
| UI 与布局 | 标签 DOM 生命周期、菜单坐标、滚轮、活动项定位、主题继承、Markdown props 身份 | 已修确认缺陷；整页主题/文件交互未穷举 |
| UI 与流投影 | start/cancel revision、终态收尾、停止后工具分组、guidance 顺序、history 合并 | 现有行为/契约测试通过；上述异步新旧判定仍需跟进 |
| Electron 与 Runtime | IPC schema、帧身份、进程重启、取消、命令/事件分流 | 已修进程串扰和取消 rejection；订阅释放仍有缺口 |
| 压缩与 cache | 95% / 下轮输出预留、活动 Turn checkpoint、前置 Turn 摘要、请求前缀检查 | Runtime 测试通过；未更改策略，未实测供应商 cache 命中率 |
| 工具与权限 | 工具暴露/授权、停止、不合作工具的结算、精确 capability、结果投影与归档分离 | 针对性及对抗测试通过；取消不代表所有外部副作用可撤销 |
| 持久化与恢复 | Turn commit、revision、supersession、完整原始工具事实、重启历史恢复 | 单元与真实 Utility Process 集成测试通过；未做磁盘耗尽/断电测试 |

## 验证记录

- UI / 后端 TypeScript 类型检查：通过。
- Vite production 构建：通过，有大 chunk 提示。
- 标签 Electron 行为测试：通过；使用真实 Chromium 离屏渲染、React StrictMode、项目 hook 和 CSS，不启动用户的产品实例。
- Runtime 主包：203/203 通过（串行复跑）；此前并发跑有一个终端定时测试失败，单项复跑及完整串行复跑均通过，保留此不稳定记录。
- Protocol 24/24、Product Agent 5/5、Product Host 13/13、Provider 22/22、MCP Client 22/22、Runtime Electron 7/7、Chrome 4/4：通过。连同 Runtime 主包共 300 项。
- Computer Use：21/22；Unicode 失败消息测试被“用户正在使用鼠标/键盘”的保护提前拦截。整条 `npm run test:runtime` 因此未全绿，不声明全套通过。
- Runtime Client 流/命令契约、进程代次故障注入、真实 Utility Process 启动/IPC/重启/持久化恢复：通过。
- 48 项 `test-*-contract.mjs`：修正过期断言后重新执行，48/48 通过。
- `git diff --check`：通过。

所有测试均使用 fixture、模拟故障或隔离临时 Runtime 数据目录；没有重跑用户真实会话的文件写入和外部副作用。
