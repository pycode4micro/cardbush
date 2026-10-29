# CardBush Apps MCP 边界

[English](CARDBUSH_APPS_MCP.md) · [简体中文](CARDBUSH_APPS_MCP.zh-CN.md)

`cardbush_apps` 是桌面发行版内置的独立 MCP 2.x stdio 服务。Electron 启动子进程，Runtime 经与用户 MCP 相同的客户端及注册表连接，不开 HTTP 端口。

## 职责与生命周期

- `@cardbush/bush-runtime` 管理不可变内置工具、准入、权限、调用/turn 生命周期、Workspace Change 和恢复。
- `@cardbush/apps-mcp` 管理随产品分发的 app 插件，首个为 `computer_use`。
- Product Host 管模型/插件配置，不执行插件；Bot、Browser、Office 等仍是独立 MCP。

连接管理由 Product Host 的独立 `cardbush_management` 提供，使用标准 MCP 客户端/注册表。其鉴权 loopback 端点仅随桌面进程存在，无独立配置库；`list_mcp_servers/configure_mcp_server/remove_mcp_server` 读写原 MCP 配置并返回实际 Runtime 快照，可选 app 插件禁用后仍可用。其他应用内依赖/加载项由各自安装器负责，独立 MCP 注册不要求 CardBush 插件包。

配置在活动 turn 热加载。`pending` 区分连接准备、资源准入、受影响本地服务 `waiting_for_calls`；本地服务自己的调用结束才释放端口，远程替换保留旧传输至已分派调用结束。下个模型轮次协调能力增删改并发一次有界通知；schema 改变需重新发现。保存配置或用另一 MCP 客户端测试不证明 CardBush 已连上。

Runtime 不硬编码 `computer_use` 或私有 `host_tool_request`。工具仅在 MCP 发现后出现，使用命名空间、标准 schema/annotations 和 `CallToolResult`，不要求私有结果信封或服务器发布 Runtime 事实。

保留 server ID `cardbush_apps`，renderer 配置不可覆盖。启用后注入 MCP 快照，用 Electron Node 启动，随 Runtime Utility Process 关闭。Product Host 修订参与 MCP 快照修订，服务/插件变化不会复用旧身份。

## 设置与操作契约

Product Host 保存 `product-host/config/apps.json`，暴露 `apps.get/apps.update`：整体服务启停、内置插件安装/卸载/启停、插件配置。Computer Use 当前包括截图目录、打开应用/关闭窗口策略、向用户输入让步及操作后恢复指针。

Computer Use 是可见原生 UI 的最后手段。桌面操作跨会话串行，输入须有新观察，重复无进展会停止。协作模式不等于 OS 隔离；独立 Windows 会话/VM 不能操控用户现有桌面应用。

### 观察与动作

不指定窗口的 `observe` 仅发现，不截全桌面；指定准确 HWND 后返回标准 MCP image 和一次性 `state_id`。`include_text:true` 默认最多 80 个 UIA 元素、10,000 字符；`include_screenshot:false` 必须提供文字证据。输出先身份/状态再树。

所有现有窗口动作必须同 HWND/state；状态 30 秒到期，动作前消费，其他 turn 改桌面即过期。优先语义 index click/invoke/set_value，通常不动鼠标；窗口相对 SendInput 是受控回退。`supported_actions` 决定能力：语义点击需 Invoke/Toggle/SelectionItem/ExpandCollapse，可写 Value/RangeValue 才能 `set_value`（替换全值），有 Value/Text 不代表可点击。无支持动作在原生分派/指针显示前失败，但仍消费状态。

`open_app` 要现有 cwd，同一 PowerShell 进程在启动前枚举并在后续最多 1.5 秒核对窗口。`window_check` 区分新匹配、已有候选、未确认；匹配依据启动 PID 或准确进程名，不是任意新窗口。候选不证明就绪，输入前仍须准确 HWND 观察；shell 交接可能复用进程或延迟，未确认不能自动重复启动。

输入/窗口动作默认 `observe_after:true`：一个动作后释放活动输入租约，等有界 `settle_ms`（默认 120、最多 1000）再给 `output.observation` 和新一次性状态。这只是延迟样本，不证明异步应用工作完成；无递归工具/模型轮询/自动重放。通常动作和观察共一个短进程，ACK 让 Node 先记分派并释放输入租约再继续捕获。前台变化可停止 worker 并需单独恢复观察；取消/捕获失败不重放已 ACK 动作。已分派而观察失败保留 `execution:dispatched`，观察报错、无状态。`observe_after:false` 保留显式 observe/action，`open_app` 沿用专用契约。

`clipboard` 必须且只能 text/files 二选一，绑定新 HWND/state。文件为已存在宿主绝对路径，不支持目录/设备路径，分派前拒绝。原生重新核对目标/列表，写 Unicode 或 copy drop effect 的 CF_HDROP 并验证后 ACK，不自动粘贴/发送；后续 Ctrl+V 需新观察。成功写剪贴板不算无视觉进展，但重复/接管 guard 仍在；回执不回显内容。

### 捕获、UIA 与执行证据

窗口捕获支持 `region`、整数 `scale` 1–3、可选 grid，只改变交付图像，完整窗口进展签名不变。image 返回原点、输入/输出尺寸、比例；输入和 UIA 坐标仍相对窗口，grid 用完整窗口像素。动作后弹窗/边界变化导致 crop 无效时回退完整目标并报 `region_reset`，显式非法 crop 拒绝。分配前限制 1600 万像素、单边 8192。

UIA 最多扫描 5000 后代，优先焦点、Edit/ComboBox、按钮，避免文件列表淹没。`element_query` 按不区分大小写名称子串、准确 automation ID/type、focused 组合 AND，先筛选后限额；`element_offset` 沿 `accessibility.next_offset` 翻页，也遵守 10,000 字符预算。分别报告匹配/返回数和扫描限制。index 绑定原生 runtime ID 及新状态，翻页使旧状态失效；焦点证据独立采集，包括纯截图。

内部 128×128 签名结合动作附近 tile 与独立焦点证据，避免文字小变化被全窗平均吞掉；光标闪烁/轻微噪声不算进展。基线绑定准确 PID/HWND，发现、全桌面截图、换目标或 UIA 过滤不能重置未完成动作计数；只有同目标证据或已验证 owner/popup 过渡算进展。可见非密码 UIA TextPattern 另用有界 hash，支持终端/文档小变动。

允许四次不同准备动作未验证分派，以完成 focus/type/Enter。随后 `progress_unverified` 需一次明确同目标复查，并允许一个不同纠正动作；仍无进展则 `policy_blocked` 锁住本 turn。相同重复及不确定失败限额更紧。`observation_required` 可恢复，终态 block 不能靠换窗或 finish 清除。动作间被动观察（含分页）最多 6 次。

观察不激活后台窗口，报告 `is_foreground`；`actionable` 表示可前台输入，`window_action_available` 表示新状态可进行窗口操作。后台目标先 `window/activate`，检查返回观察再输入。激活直接验证 HWND、进程、边界（含次窗口），Windows 未实际切前台即失败，焦点变化算进展。

分派前状态/显示拒绝不计无进展周期，但相同重试及六次 preflight 失败分别有限额，允许不同修正而不无限循环。分派后失败保守计数，因可能已有部分效果。

### 用户接管与展示

提示区分物理鼠标/键盘 `user_takeover`、Escape/Stop `user_stopped`、前台变更 `window_changed`、目标消失 `window_unavailable` 和 worker/租约错误。仅真实输入增加接管预算；Stop/Escape/终态 guard 锁住 turn。自有指针、按钮、按键全部用相同 SendInput tag，含负原点多显示器坐标，前台丢失立即拦后续输入。错误给 `execution:not_dispatched|dispatched|unknown` 和恢复说明，unknown 意味可能部分生效。

动作后捕获仅跟随经过进程及 OS ownership 验证的前台 popup，或关闭 popup 的已观察 owner；输出 `requested_hwnd/target_relation`、owner HWND 和前台关系，同 PID 兄弟窗口不能自动跟随。发现包括无标题 owned/foreground 窗口。捕获复核 HWND/进程/边界，期间前台变化不发状态。

展示寿命独立于输入许可：物理接管、前台丢失和可恢复失败保留窗口 child surfaces，显示暂停/等待，不反复拆边框；动作间只隐藏指针。后台裁剪由父窗负责，Stop/Escape、finish、取消、目标销毁及 worker/idle 租约清理才结束展示。

捕获只在 PrintWindow/像素复制期间遮罩带标记 CardBush child surfaces，启动、编码、UIA 期间仍可见。恢复核对活动 marker，不能在 Stop/finish 后复活，最终清理处理被杀捕获留下的 mask。UIA 排除这些 surface，桌面操作租约持有到观察及失败清理结束。

长文本逐 Unicode 码点分派，每字符复核进程/前台；失焦/暂停丢弃 tagged down，但保留 release 避免卡键。drag 重查目标/路径。LF/CRLF/CR 各发一个 Enter 对，保留空行而不双倍换行，其他字符保留代理对处理；Enter 可能提交/执行。成功回执仅证明分派，应下一次观察验证应用效果，例如忙于其他进程的终端接收字符不等于执行了命令。

目标 PrintWindow 失败就失败且不发 state，不用可能显示遮挡应用的桌面 crop 冒充，明确目标捕获限制。

## 原生传输、诊断与图像

PowerShell 固定短 bootstrap，经 stdin 一行 Base64 传完整 UTF-8 脚本。大脚本/参数不进命令行或单值环境块，使用 script-scope 变量；已运行进程里的 `$env` 大值仍受 Windows 限制。Windows 构建预编译 C# 到 `packages/cardbush-apps-mcp/dist/native`；其他机器构建的包只在本机缓存补编缺失不可变库。文件名含源码/引用 hash，不误复用旧库；每请求仍启动/退出进程，没有常驻执行器。

PowerShell 错误保留有界可读诊断、解 CLIXML，省进度 XML 和编码命令。超时明确动作结果不确定，取消仍是取消。`timings` 含 `total_ms/process_count/process_start_ms/initialization_ms/compile_ms/input_ms/screenshot_ms/uia_ms/settle_ms`；初始化含程序集加载，总量另有校验/显示等，不是各阶段严格和，也不含模型/网络；失败保留已有测量。

图像沿用通用 MCP 交付和不可变 image store，UI 文件产物保留，避免重复模型注入。交付失败可见，不推断动作失败。MCP 客户端仅移除与 `structuredContent` 语义完全相同的 JSON 文本，保留 prose、不同 JSON、图像及完整原生日志。

## 验证与卸载

Windows 单测覆盖长脚本、Unicode、每种生产输入动作原生目标验证、取消和 spawn 错误；还有 Apps MCP 单测及可选 `npm run test:native --workspace=@cardbush/apps-mcp`。真实套件创建可丢弃 WinForms/WPF/唯一标题 Windows Terminal（需 `wt.exe`），在交互桌面串行运行。独立应用 IPC/marker 验证效果，不把分派 ACK 当成功，截图/报告写临时目录。历史覆盖见 [2026-09-05 报告](../COMPUTER_USE_TEST_REPORT_2026-09-05.md)。busy 拒绝并发调用不取消当前拥有者，包括同 scope。

卸载只是本地目录状态变化，内置包保留供重装、工具不注册；禁用服务从 Runtime 快照移除整个 server。两者都不引入默认工具或私有桥。
