# 应用中心 · HTML 组件与固定页面

更新：2026-09-30。本文保留前期设计与后续扩展方向。首版现已接入生产代码，实际接口、已完成范围与验证见 [HTML 组件与多页面首版](HTML_COMPONENTS_V1_2026-09-30.md)。下面未在首版文档中列出的能力仍是拟议方案。

## 本轮边界

**保留目前 CardBush UI。组件功能是一项从现有应用中心打开的应用，不改新会话默认页、侧栏导航、会话区或现有输入框。** 组件画布只存在于该应用内，暂不提供“替换首页”。

- 自定义 UI 使用 HTML/CSS/JavaScript；宿主只管理位置和尺寸，不提供圆角、配色、字体、内边距等设计面板。
- 接入、预览、编排和固定页面管理统一归属「组件」应用。右侧只提供用户已固定的入口及“自定义接入”跳转；没有固定项时不占位。
- 后端 Python/TS 均可，通过语言无关消息协议接入，不把语言写死，也不提供任意 shell 执行入口。
- 不内置 Agent 生成组件、组件工坊、创作对话或专用 author API。未来外置插件产出相同组件包即可。
- 前期原型中的模拟动作与设置不能当作产品能力；实际支持范围以首版实现文档为准。

## 应用与编排

现有应用中心增加一个「组件」应用，内部呈现组件画布与管理工具。首版默认空画布，用户自行导入 HTML，不改变现有欢迎页。

「编辑布局」时出现拖拽/缩放手柄，属性区只提供宽度、高度，以及添加/移除。支持键盘移动、数值调尺寸、撤销/重做、取消和保存。编辑时屏蔽业务动作，保存形成一次布局事务；撤销布局不会撤销已经发起的任务。

建议响应式网格：宽屏 12 列、中屏 6 列、窄屏单列；按断点保存网格位置与顺序，碰撞避让，不覆盖宿主控件。HTML 收到实际尺寸后自行排版，不缩放整个 iframe 或字体来硬塞。低于最小尺寸时提示空间不足。组件定义与实例分离，同一 HTML 可放多个实例，各实例草稿独立；共享数据域必须显式声明。

## HTML 与主题

首版接入本地 HTML 入口及资源目录，或已安装插件提供的 HTML 包。静态 HTML 默认没有宿主权限；需要 hooks/动作时提供清单并校验。资源限制在授权包内，拒绝路径逃逸。远程站点继续使用现有浏览器入口，固定它不自动授予组件桥接能力。

同一 HtmlSurfaceHost 支持 canvas 与 inspector 两个展示位置。前者由宿主管网格位置/尺寸，后者由宿主管固定、切页与覆盖；内部布局与业务交互都由 HTML 决定。

宿主注入带版本的主题变量：背景、文字、弱文字、边框、交互表面、强调色、字体、代码字体、字号、减少动画偏好；提供表单继承等最小基础样式，并推送主题、语言、尺寸变化。作者使用 --cb-* 变量或继承样式，无需逐主题配置。

自动跟随主题是组件契约，不能自动修正任意 HTML 的硬编码颜色。预览校验明暗主题、窄尺寸与对比度；不强行覆盖图表和图片中的语义颜色。主题更新不重建页面。

## 包与消息协议

组件包只有 HTML 入口、可选资源、可选后端命令声明，不引入卡片 DSL 或低代码表达式语言。

```ts
type HtmlSurfaceDefinition = {
  apiVersion: 'cardbush.html-surface/1';
  id: string; version: string; title: LocalizedText;
  entry: PackageResourceRef;
  placements: Array<'canvas' | 'inspector'>;
  size?: { default: GridSize; min: GridSize; max?: GridSize };
  capabilities: CapabilityDeclaration[];
  commands?: Array<{ id: string; input: JsonSchema; output: JsonSchema }>;
  stateVersion: number;
};
type SurfaceInstance = {
  id: string; definitionId: string; definitionVersion: string;
  config: JsonValue;
  layouts?: Partial<Record<'wide' | 'medium' | 'compact', GridRect>>;
  binding: { host: HostRef; project?: ProjectRef; conversation?: ConversationRef };
};
type Request = {
  jsonrpc: '2.0'; id: string; method: string; params?: JsonValue;
};
```

surface.initialize → host.ready 协商主版本、已批准能力、公开上下文、主题、尺寸与状态版本。不兼容时局部失败，不先运行再猜。每个实例建立独立通道；身份由宿主通道绑定，HTML 不能传入别人的 instanceId、sessionId 或权限字段来扩大能力。

| 方法 | 语义 |
| --- | --- |
| data.read(query, args) | 具名数据源，最小必要数据，返回状态与 revision |
| events.subscribe(topic, filter, cursor) / unsubscribe | 返回 subscriptionId；事件包含 eventId、sequence、contextRevision |
| actions.invoke(command, args, contextRevision, idempotencyKey) | 调用已批准的具名命令，返回接纳回执或结构化错误 |
| actions.get(receiptId) / cancel | 超时后先查询，不盲目重发；报告取消/完成竞态 |
| state.read / patch(expectedRevision, patch) | 按实例隔离，乐观并发控制 |
| host.contextChanged / visibilityChanged / resized / dispose | 生命周期通知，不代表用户执行授权 |

建议初始控制消息上限 128 KiB、每实例最多 8 个在途请求；初始化超时 10 秒、普通 RPC 30 秒。长任务及时返回回执，大数据采用分页/资源句柄。这些是压测前的建议值，实现时协商并固化，不声称已验证。

错误区分 INVALID_REQUEST、CAPABILITY_DENIED、STALE_CONTEXT、REVISION_CONFLICT、HOST_UNAVAILABLE、TIMEOUT、CANCELLED。请求与返回值均校验，权限失败不能伪装成无数据。

### hooks 与动作分开

本地 DOM 事件由 HTML 自己处理；点击需要 CardBush 能力时调用具名动作。hooks 提供生命周期与业务事件订阅，不暴露 React hooks 或 Electron IPC。

```ts
const stop = await cardbush.events.subscribe('task.completed', {}, refreshSummary);
button.addEventListener('click', () => cardbush.actions.invoke({
  command: 'conversation.submit',
  args: { target: selectedTarget, text: draft, delivery: 'queue' },
  contextRevision: currentContext.revision,
  idempotencyKey: stableSubmissionKey,
}));
```

自由决定“点哪里调用哪个已批准动作”；宿主核验能力、目标与执行政策。自动化事件触发模型任务须有明确的自动化绑定，复用现有机制；mount、resize、订阅重放不默认触发模型。事件带 causeId，运行侧去重、限制触发频率，防止自动化递归。

断线按 cursor 补读，不能补齐则 resyncRequired 后取快照。消费者按 eventId 去重并丢弃旧 contextRevision。销毁取消订阅和未接纳 RPC，已接纳任务继续归 Runtime 管理，不因关页而终止。后台页暂停不必要的更新，宿主共享订阅，不让每页独立轮询。

### 后端语言

UI 始终为 HTML，后端由插件/执行宿主通过同一序列化协议适配，Python/TS 不影响前端契约。只能调用包声明并已授权的命令，不将脚本路径拼入任意 shell。先复用现有插件运行与权限设施；尚缺的语言 adapter 单独实现和验收，不把支持 HTML 宣传成任意后端已经能运行。JS/Python SDK 是协议 helper，不是协议本身。

## 会话、引用与 cachechain

模型动作明确选择新建、继续指定会话或 fork，画布本身不是 session。右侧页可绑定一个会话，或跟随打开时的上下文，但发送前冻结具体目标。

- 宿主解析目标后创建/核验 sessionId；组件、页面、实例 ID 均不能替代 sessionId 或成为请求头中的会话标识。
- 回执包含 hostId、sessionId、turnId/runRef。双击、重连、超时重试沿用幂等键；服务端作用域至少含用户、宿主、动作和目标，同键不同内容返回冲突。去重记录与任务接纳持久化，不只留在 iframe 内存。
- 切页、主题、尺寸、固定、覆盖不改模型历史、不追加系统提示词、不更新 cachechain。只有实际发送与显式引用进入请求。
- 复用当前 Composer 的 @ 引用、/ 命令、$ 插件入口及提交路由；$ 不重新定义为风格等其他功能。
- Source、文件/历史引用和子代理归属保持现有语义；页面内容不会自动注入模型，通过 @ 或明确动作才进入引用管道。
- 上下文变化使旧 revision 失效，在途结果仍归原任务。权限依据宿主政策，不接受 HTML 自称“用户已同意”。

## 右侧固定页面与 Beta

现有右侧加号增加「自定义页面」，跳转应用中心的接入入口。固定项与临时文件、浏览器、审查、子代理等页签分离，不替代现有 Inspector。没有固定项时不增加默认空栏。

固定项保存 pinId、definitionId/version、label、order、configRef，首次打开才创建 viewInstanceId；重复点击聚焦原实例，切换保留草稿、滚动与 UI 状态。取消固定只移除快捷入口；关闭才释放实例。包失效显示修复入口，不无限重试；卸载包不删除用户工作文件。

多页面 Beta 仅限制新自定义页面的多实例能力，不改变现有 Inspector 多标签。默认关闭，单页可用；添加第二个或主动开启时提示：

> 多页面仍处于 Beta。在不同 DPI、缩放比例或多显示器之间切换时，页面尺寸、弹层位置和输入焦点可能表现不佳。可以随时在应用中心关闭，已固定的页面会保留。

「暂不开启」不创建第二个实例；「开启 Beta」才继续。确认按设备和提示版本保存，不因云端同步在另一设备跳过。关闭时保留固定项和可恢复草稿，只保留一个活动自定义实例；已接纳模型任务不停止。遇到尚未持久化的草稿先完成保存或保留原状态，不静默丢弃。

## 覆盖内容区与沟通胶囊

自定义页可覆盖左侧栏、会话区、右侧栏，**顶部窗口动作/菜单栏保持可见**。与 F11 系统全屏分开，不改变默认布局。持久 SurfaceLayer 调整同一个页面容器范围，避免在两个 React 树间重挂 iframe；保存并恢复尺寸、滚动和焦点。DPI 变化使用实际 CSS 尺寸，不重复乘 devicePixelRatio。

覆盖时宿主提供始终可达的「返回 | 输入」胶囊：

- 返回退出覆盖并恢复原右侧页及会话，不刷新页面。Escape 先收起命令候选/弹窗/输入，再退出覆盖，输入法组合状态不误触发。
- 输入只展开文本框和发送/停止控制，不显示模型、权限、附件工具栏；@、/、$ 复用现有 Composer controller。
- 目标是进入覆盖时的会话；没有会话则首次发送才创建，取得回执 sessionId 后继续同一对话。主界面异步切换不能改未发送草稿的目标，目标失效须重新绑定。
- 继承目标会话的模型、权限、队列/引导政策；空草稿运行中提供停止，失败保留草稿。Enter 发送、Shift+Enter 换行、中文 IME 不误发。
- 胶囊、候选与权限弹窗属于宿主层，HTML 无法覆盖。向页面通知遮挡 insets；焦点陷在页面时顶部动作栏仍能退出。

简化的是可见选项，不是另一套发送或授权实现。

## 隔离、保存与未来扩展

抽取 MCP App 的通用隔离和受控桥接基础，不伪造 tool call/结果/会话 token。实例通道校验发送窗口、协议、消息大小、能力；导航、销毁、升级后旧通道失效。HTML 不获得 Node、原始 IPC、主应用对象、API Key 或任意文件访问。默认静态页面不联网，需要网络时显式声明并走宿主政策。

错误边界、后台请求配额、主题/尺寸事件合并、减少动态效果均由宿主提供。停止桥接不足以阻止脚本 CPU 死循环，需验证 Electron renderer/guest 隔离与恢复，不让第三方脚本拖死主 UI。

布局、配置、固定项带 schemaVersion/revision 原子保存，编辑使用 expectedRevision。包版本不原地漂移，迁移失败保留旧版本。同步资源内容引用与布局，不同步本机绝对路径、进程句柄、设备启动状态或凭据。

开机自启动和“启动后打开组件应用”留在该应用设置中，默认关闭，不改当前启动页。设备设置读取真实系统状态；启动 UI 不自动运行模型或开启连接器。MSIX 启动继续按包内 StartupTask 设计，后续验证 Windows 11 启停、系统禁用、升级、卸载，不通过包外 Run 注册表绕过清理要求。参考 [Microsoft StartupTask](https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.startuptask)。本轮没改启动代码。

未来外置 Agent 插件使用普通组件包和导入途径。现在预留稳定 ID/版本、资源引用、声明能力、状态版本与布局 revision 即可；不提前内置创作功能。生成的包和手写包接受同样的验证与权限。

## 现有接点与实施顺序

| 现有位置 | 后续接入 |
| --- | --- |
| src/features/appCenter/AppCenter.tsx、appCenterModel.ts | 注册「组件」应用，沿用现有打开机制 |
| WelcomeComposer.tsx、ChatPanel.tsx | 保持默认首页与会话 UI |
| McpAppPanel.tsx、mcpAppBridge.ts | 提取 HTML 基础宿主，保留 MCP 原语义 |
| inspectorTabs.ts、InspectorTabPages.tsx | 自定义页类型、切页保活，固定项另存 |
| Composer.tsx、conversationHost.ts | 复用输入 controller 和提交路由，只增加无工具栏表现层 |
| App.tsx 右侧菜单与内容容器 | 可选接入项、固定入口、覆盖宿主层，默认不占位 |
| 插件执行与共享配置设施 | 具名命令、权限、包版本、布局与设备状态分离 |

设计阶段核对：InspectorTabPages 保留非活动页实例；McpAppPanel 依赖工具身份并校验 frame window/origin/token；Composer 已有 slash/plugin/mention/style 模式。HTML Surface SDK 当时尚不存在，首版现已另行实现，未改变 MCP Apps 的工具协议。

分阶段：①应用中心、包/实例协议、主题与编排；②只读 hooks 和真实动作路由；③固定页、Beta、覆盖胶囊；④按需补语言 adapter 和系统启动。Agent 创作插件不在此实施清单。

生产验收必须涵盖默认 UI 不变、会话隔离/幂等/取消竞态/事件重放、引用/Source/cachechain、切页草稿、IME/命令/停止/排队，以及 100%/125%/150%/200% 与跨屏 DPI；隔离、恢复、同步、自启动用真实环境验证。

## 前期原型验收（2026-09-30，独立于生产验收）

已在隔离无头 Edge 中通过交互检查：应用中心进入组件应用；数值调尺寸、指针拖拽/缩放、撤销、取消、保存；固定页面；Beta 取消/开启/关闭；页面草稿与 DOM 实例在切换和覆盖前后保留；顶部动作栏不被覆盖；快速输入的 @、/、$ 候选、IME 防误发、发送/停止与 Escape 返回。320px 画布、编排和覆盖模式无横向溢出，明暗主题截图已检查，未捕获 JavaScript 异常。

右侧页打开后，画布按自身可用宽度重排，而非仅依据窗口宽度判断，避免分栏时组件内容被挤窄。以上验证只覆盖交互原型，不代表真实 Electron 进程隔离、API、操作系统 DPI 或启动项已经验收。

原型文件：线程可视化目录中的 cardbush-html-components.html；检查脚本：check-html-components.cjs。原型的应用中心可试用编排、接入示例与右侧固定页面。该原型不执行用户导入的任意 HTML、不调用模型、不注册启动项，只模拟界面与回执；与后来接入生产代码的首版不是同一验收对象。
