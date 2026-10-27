# Browser Use（Windows 11）

Browser Use 的打开、导航、选中和列表结果会返回可直接用于 Markdown 的 `reference`。点击它按标签身份定位 CardBush 或对应 Chrome / Edge 配置中的现有页面，页面已导航也不会回退到旧网址。点击仅改变显示，不切换 Agent 的操作目标或浏览器绑定；已关闭标签显示状态和独立的重新打开按钮。

设置入口：应用中心 → 设置 → 浏览器 → Browser Use。

本机 Chrome/Edge 首次由用户在 CardBush 风格的扩展窗口确认一次连接，无需输入配对码；不要代替用户确认。本机 App 和 CLI 共用连接，断线或重启后自动重连，CLI 使用 Chrome/Edge 不依赖桌面 App。输入 `/browser status` 查看连接和扩展目录。Agent 用 `list_browsers` 找到对应配置 ID 后再 `select_browser`，不能将 `chrome`/`edge` 名称当作 ID。`/browser default ID` 设置默认连接，`/browser revoke ID` 撤销单条连接。

自动恢复连续失败最多 3 轮后停止，等待用户主动重试。宿主可输入 `/browser retry`；扩展点击「连接 CardBush」重试当前目标。打开面板、状态查询或扩展重启不重置已耗尽的次数。旧配对持续失败且用户要连接当前本机时，点击「重新申请本机连接」在扩展窗口确认一次；此后主动重试继续本机申请，不退回旧配对，扩展重启也保留该意图。普通旧配对重试不主动触发重新授权，成功前不覆盖原配对或清除网站授权。拒绝或取消后停止，用户再次点击才重新申请。`/browser status` 和 `list_browsers` 提供最近握手时间、阶段与拒绝原因，不能用过期日志推断当前状态。

配对码仅用于手动连接或远程 Agent 配对。在目标 Agent 的 CLI 输入 `/browser pair chrome` 或 `/browser pair edge` 生成配对码；也可从桌面设置的手动配对入口生成本机配对码。用户直接将码粘贴到目标浏览器扩展，不发送给模型；通过 CLI 生成时保持该 CLI 开启。远程 Agent 独立管理连接，不继承本机 App/CLI 的连接。已有连接临时离线应恢复原连接，不要求重新授权或重新配对。

本机 Browser Use 同时支持 CardBush 内置浏览器与外部 Chrome / Edge。在输入框通过 `@ → CardBush 浏览器` 选择标签页，会把当前会话绑定到那个真实的内置页面；相同网址的 Chrome / Edge 标签不是同一目标。内置页面需要桌面 App，但无需扩展、配对或开启外部连接器。Agent 可通过 `list_browsers` 选择 `connectionId: cardbush`，再使用 `new_page` 创建内置标签。快照、点击、输入、导航和截图使用同一组 Browser Use 工具。

首次发送和跨会话明确引用时，未锁定的原标签会归入引用它的会话，保留同一个网页实例；锁定标签仍由原会话持有并共享显示。工具的 `selected` 是 Agent 的目标，`active` 是界面选中状态，`visible` 是实际网页可见状态。后台任务不切换当前会话；隐藏网页截图会直接返回 `cardbush_page_not_visible`，应显示所属会话并选择原标签后再截图。

内置浏览器只开放用户在该会话中引用的标签或 Agent 为该会话新建的标签。已关闭、被替换、应用重启后尚未重新选择的目标会明确报错，不按网址寻找替代页面，也不切换到 Chrome / Edge。远程 Agent 不具备控制本机内置标签的通道，需在本机会话中操作。当前内置模式不支持 `download_file` 的任务跟踪接口；它会明确返回不支持，不转发到外部浏览器。

启用 Browser Use 插件，在要使用的 Chrome 或 Edge 中加载随应用提供的扩展。管理页分别为 `chrome://extensions` 和 `edge://extensions`；两种浏览器和不同用户配置首次分别确认连接，可以同时在线。升级后重新加载原扩展；正常重启自动重连，重试耗尽后需要点击「连接 CardBush」。手动配对码的五分钟有效期仅限制首次接受，已建立的连接不会在五分钟后过期。

默认连接用于尚未选择浏览器的会话。模型使用 `browser_use` 的 `list_browsers` 查看连接，用 `select_browser` 显式选择；绑定后不会因为默认值改变、断线或重启而切换。成功切换后重新获取页面和元素 ID。

配对只建立连接，个人标签和站点授权仍在扩展中选择。普通退出、关闭连接器都保留配对；再次开启后可自动重连。明确关闭扩展连接则需点击连接恢复。移除单个连接仅撤销该配对；“移除连接器配置”撤销全部配对并清理会话绑定。站点/全部网站授权保存在浏览器本地，重启后仍有效，只在扩展中撤销授权或清除扩展数据后清除。

保存的连接端口被占用或被 Windows 拒绝绑定时，桌面会自动尝试可用候选端口。Browser Use 1.2.4 起的扩展会通过原配对校验找到新地址并保存，保留网站授权和会话绑定。升级后需重新加载原扩展；无需删除配对，也不要修改系统端口保留范围或关闭其他程序来修复。

断线时不确定动作是否已执行，应先恢复连接并观察，避免重复发送、下载或提交。不要读取配对文件或把配对码发送给模型/第三方。

Browser Use 的 `upload_file` 可直接将本机绝对路径的文件交给内置标签或已配对 Chrome/Edge 的文件输入框，支持隐藏控件和多文件控件；无需本地 HTTP 服务。文件选择与网站上传完成是不同状态，需继续检查预览或进度。系统文件窗口、裁剪、拖拽等交互可衔接 Computer Use，保持同一浏览器、账号和标签，基于新观察执行鼠标键盘操作。

## 页面状态、点击诊断与结果验证

继续使用 `take_snapshot`、`click`、`wait_for` 三个入口。`take_snapshot` 保留 AX 的布尔假值、`mixed`、弹出菜单类型、层级和关联节点，例如 `expanded:false`、`checked:"mixed"`、`haspopup:"menu"`、`controls:[cb_123]`。`interactiveOnly:true` 只筛选交互候选，仍保留禁用控件供判断；也可同时使用 `rootUid/query/roles`。

需要几何信息时设置 `inspectLimit:1..20`，只检查首个返回页内至多这么多个候选，报告隐藏、禁用、区域、视口、完全裁切和 `pointerEvents` 等事实。没有 `observation` 的行没有接受检查；即使已检查，也不代表可点击：快照是历史观察，子元素可能覆盖父元素的 `pointer-events` 设置，实际命中仍由点击前检查决定。游标续页复用原快照，不重新检查节点。计数只覆盖当时已加载的 AX 树，虚拟列表未加载的总量为未知。

`click` 自动滚入视图后检查两帧稳定性，在悬停之后和每次按下之前重新检查稳定性与真实命中。失败回执提供 `reason`、目标和命中元素事实、`autoScrolled`、`mouseMoved`、尝试按下次数以及可能已生效的点击；无法确定原因时返回 `unknown`。未发送按下不等于页面没有变化，滚动和悬停可能已经改变页面。不会自动关闭遮挡层、hover 祖先、改用 JavaScript 点击或按 Enter。`inputDispatched:"possibly"` 或已完成部分双击时，先观察，避免重复提交。

成功回执的 `postState` 是即时证据，`outcomeVerified` 仍为 `false`。URL、焦点或 DOM 变化不能直接证明业务完成。用 `wait_for` 等待明确条件，或重新读取页面核对结果；不用“网络空闲”推断成功。例如日期设置并等待结果区域完成更新：

```json
{"conditions":[{"kind":"value","uid":"cb_101","value":"2026-10-18"},{"kind":"state","uid":"cb_102","name":"busy","value":false},{"kind":"text","text":"加载中","present":false}],"timeout":10000}
```

`uid` 必须替换为当前快照中的实际节点。也支持 `visible`、`enabled`、`expanded/checked/selected` 状态和 URL 的 `equals/includes` 条件；`text` 参数可用于简单等待文字出现，与 `conditions` 二选一。所有条件在同一轮轮询中逐一检查，并非原子页面快照。`visible` 表示节点存在、样式可见且有区域，不代表无遮挡或已在视口内。缺失的 ARIA 状态为未知，不能当作 `false`；首次无法解析节点也不能证明已消失。页面或子 frame 导航会使定向等待失效，需要新快照。超时返回最后观察，取消后停止轮询，不留下页面定时器或观察器。

本次面向 Windows 11。高级远程调试仍只用于主动开启调试的 Chrome；操作内置标签请使用普通 Browser Use 模式，不自动切换模式。
