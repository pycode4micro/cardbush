---
name: browser-use
description: 在 Windows 10 / 11 上通过 Browser Use 操作 CardBush 内置标签或已授权的 Chrome、Edge。本机首次确认后自动重连，配对码用于手动连接或远程 Agent 配对。尊重 @ 标签页的真实身份，支持网页读取、点击、表单、本地文件上传和截图；外部浏览器另支持跟踪下载，原生窗口与特殊控件可衔接 Computer Use。
---

# Browser Use

使用宿主暴露的 `browser_use` MCP 工具。支持 CardBush 内置浏览器，以及 Windows 10 / 11 上通过扩展分别配对的 Chrome、Edge 和用户配置。

## 选择连接

- 用户 `@` CardBush 标签页时，宿主已绑定真实内置页面；先 `list_pages` 和新的 `take_snapshot`，再操作返回的页面和元素。不能把相同网址的 Chrome / Edge 页面视为同一标签，不能重新打开网址替代原页面。
- `selected` 只表示 Agent 的操作目标，`visible` 才表示网页当前显示在 CardBush 中。`new_page` 默认后台创建，`select_page` 默认只选择操作目标，均不切走用户当前标签或窗口。读取、导航、点击和输入优先在后台完成；仅在用户要求展示时用 `new_page(background:false)` 或 `select_page(bringToFront:true)`。内置页面截图仍要求页面实际可见，后台会话需要用户显示其所在会话。不要根据 DOM 有内容宣称用户已看到，也不要删除网站的隐藏属性来“修复”宿主展示问题。
- 主动使用内置浏览器时，`select_browser` 传 `connectionId: cardbush`，再 `new_page`；无需扩展或配对。只有当前会话明确引用或新建的内置标签可用。关闭、替换或重启后的目标不可用时，请用户重新 @，不自动回退到外部浏览器。远程 Agent 不能控制本机内置标签。
- 内置模式支持快照、点击、输入、导航、截图和页面脚本。隐藏页可读取和导航；原生输入与截图要求页面实际显示。收到 `cardbush_page_not_interactive` 时没有发送输入，请用户显示已有标签，不自动抢焦点。暂不支持跟踪下载工具，收到明确的不支持错误时不要换浏览器重试。

- 用户指定 Chrome、Edge 或某个账号配置时，先 `list_browsers`，再用返回的连接 ID 调用 `select_browser`。多个同类连接时按用户提供的连接名称判断；仍有歧义再询问。
- 未指定时使用设置中的默认连接。首次页面调用会固定会话归属；修改默认值不改变已绑定会话。
- 切换连接会先释放旧浏览器的本会话控制。切换成功后重新 `list_pages` / `new_page` 和 `take_snapshot`，不复用旧页面、元素 ID。
- 离线或授权撤销不能自动改用另一个浏览器。连接断开时动作可能已经执行，先恢复原连接并观察，再决定是否重试。

## 页面工作

- 用户只需打开网页并保留观看（例如直播间）、且未指定浏览器或账号配置时，优先使用宿主 `open_external_url`，不要求先连接 Browser Use。它由主进程交给系统默认浏览器，返回仅确认打开请求已发出，不代表页面加载成功。读取、点击等自动操作仍使用本技能的连接器；离线时不以默认浏览器替代用户指定的浏览器/配置。
- 不用 `terminal_exec` / `Start-Process` / `start` 打开需要保留的用户浏览器：终端结束会清理新启动的子进程。工具不可用时提供链接，不关闭进程保护或通过保活终端绕过清理。
- `list_pages` 只列本会话可操作的标签。外部浏览器限定本会话标签组；内置浏览器限定已引用或新建的页面。`new_page` 在已选浏览器创建标签；未指定网址时创建空白页。
- 向用户展示已打开页面时，优先原样使用工具返回的 `reference` 作为 Markdown 链接地址，例如 `[AA 榜单](返回的 reference)`。它会定位原浏览器的原标签，保留当前页面状态；普通网址只表示网站，不能替代标签身份。不要自行编造标签引用。标签已关闭时界面会提示，并由用户明确选择重新打开。
- 个人标签页必须由用户在扩展面板中选择目标 CardBush 会话、授权并复制进组。配对不等于网站授权，不绕过授权或搜索其他会话标签。
- 优先使用 `take_snapshot` 返回的元素 ID 配合 click / fill / type_text；页面变化后重新观察。
- `take_snapshot` 默认渐进返回，正文只在 `content` 中出现一次；`structuredContent` 给出数量和续读游标。优先用 `rootUid`、`query`、`roles` 缩小范围，需要更多时传 `cursor`，不必自动读完整页。游标沿用同一次采集，最多保留三分钟；导航、重新采集、释放连接或缓存回收后会明确报失效。它不是实时更新的页面状态。
- 快照保留 `expanded:false`、`checked:"mixed"`、`haspopup:"menu"` 等状态及关联节点。`interactiveOnly:true` 筛选交互候选，包括禁用控件。可选 `inspectLimit:1..20` 只检查首个返回页内有限候选的区域、隐藏、禁用、裁切等事实；未带 `observation` 的行未经检查，所有快照都未经实时点击命中确认。数量仅代表已加载的 AX 树，虚拟列表未加载总量未知。
- 长字段明确标为预览；需要原文时传 `rootUid` 和 `fullText:true`，按返回的字段、字符偏移及游标渐进读取。超出采集预算会说明遗漏数量，进一步缩小范围或用 `evaluate_script` 按指定偏移读取相关文本，避免整页输出。
- `click` 自动滚入视图，检查两帧稳定性、可见性、禁用状态和真实命中，在鼠标移入后及每次按下前复查。零面积控件仅可经明确关联的可见 label 点击，不自动 hover 祖先、关闭遮挡或强行执行 JavaScript click。失败回执包含原因或 `unknown`、目标与命中元素事实、滚动/悬停和按下次数；没有按下不代表页面无变化。`input_dispatched` 和即时 `postState` 都不证明业务成功，`outcomeVerified:false` 保持明确；若输入可能已生效，先观察，不能盲目重试或换成 Enter。
- 用同一个 `wait_for` 等待明确结果：简单文字出现传 `text`；复合要求传 `conditions`，支持 `text` 的 `present:false`、`value` 的精确值、`visible`、`enabled`、`state`（busy/expanded/checked/selected）和 `url`（equals/includes）。条件逐一检查，不是原子快照。例：`{"conditions":[{"kind":"value","uid":"cb_101","value":"2026-10-18"},{"kind":"state","uid":"cb_102","name":"busy","value":false}],"timeout":10000}`，节点必须替换为实际观察所得。`visible` 不证明无遮挡，缺失 ARIA 状态不能视为 false，首次找不到节点不能证明已消失。页面或子 frame 导航后重新获取 uid；超时看最后观察，不用网络空闲或任意 DOM 变化推断成功。
- 截图使用 `take_screenshot`，图片提取使用 `export_image`；结果自动附图并保存，无需通过下载来查看图片。
- 文件下载使用 `download_file`，保留 taskId 后用 `download_status` 查询或 `cancel_download` 取消。pending 不代表失败，不重复提交同一下载。
- 本地图片、视频、文档上传使用 `upload_file`：传宿主上的绝对路径数组 `filePaths`，以及文件输入框的 `uid` 或页面观察得到的唯一 `selector`（二选一）。隐藏的 `input[type=file]` 也支持；看不到 uid 时可用 `evaluate_script` 查明控件的 id/name/accept/multiple，再选择具体控件，不能盲选多个控件中的第一个。多文件需控件支持 `multiple`。无需先点击以打开系统文件窗口，也无需启动本地 HTTP 服务、传 Base64 或注入 DataTransfer。
- 上传回执只表示文件已交给控件，网站可能随即开始上传。检查文件名、预览及上传进度/成功状态；保存、发布按用户任务继续执行。页面清空或移除 input 不代表上传失败；断线或状态不明时先观察，不重复选文件。
- 完成浏览器工作后调用 `release_browser`；它只释放本会话组的控制，不关闭用户浏览器。

## 鼠标键盘衔接

- 需要操作系统文件窗口、裁剪/拖动/画布、浏览器原生菜单，或网页接口已明确无法操作目标时，可以直接发现 `computer_use` 并读取 Windows Control 技能，不必反复尝试页面脚本。普通 DOM 点击、输入和文件选择仍优先使用对应 Browser Use 工具。
- 保持同一个已授权标签、浏览器和账号。先观察窗口列表，再观察确切 HWND；依据最新截图或可访问控件操作鼠标键盘，不能复用页面截图坐标当作窗口坐标。选择文件时在真实文件名栏输入绝对路径并确认，随后核对页面预览。若桌面上无法识别该标签，先说明缺少的目标信息。
- 完成这一步后调用 Computer Use 的 `finish`，回到原 Browser Use 标签重新观察。不要通过切换工具绕过权限拒绝、用户停止或用户接管，也不要因回执不明确而重复上传/发布。

## 连接设置

本机 Chrome/Edge 的正常流程无需输入配对码。启用 Browser Use 插件，在目标浏览器安装或重新加载扩展，由用户首次在 CardBush 风格的扩展窗口确认一次连接；不要代替用户确认。本机 App 和 CLI 共用连接，断线或重启后自动重连；CLI 使用 Chrome/Edge 不要求启动桌面 App。内置 CardBush 标签需要桌面 App，但无需扩展或配对。

用户可在 CLI 输入 `/browser status` 查看连接状态、最近握手诊断和扩展目录。Agent 调用 `list_browsers`，将返回的 Chrome/Edge 配置 ID 传给 `select_browser`；不要将 `chrome` 或 `edge` 当作 connectionId。扩展与宿主恢复连续失败最多 3 轮后停止自动请求：宿主由用户输入 `/browser retry` 重试，扩展由用户点击「连接 CardBush」重试原配对。打开面板、状态查询和扩展重启不会重新开启已耗尽的自动重试。不要反复轮询、换用其他浏览器或因临时离线要求新配对码。

已保存的配对持续失败、且用户明确要连接当前本机 App/CLI 时，可在扩展点击「重新申请本机连接」，在 CardBush 风格的扩展窗口确认一次。普通重连不主动改成重新授权；用户已选择本机申请后，「连接 CardBush」会继续该申请，不退回旧配对。此意图在扩展重启后保留，手动输入配对码才会另选目标。新申请成功前保留原配对与网站授权；拒绝或取消后停止，只有用户再次点击才重新申请，不代替用户确认。

连接失败时优先依据本次 `list_browsers` 的状态：`host_unavailable` 表示宿主启动失败，按 `connector` 中的 `checkedAt`、`message` 和 `nextStep` 排查；`disabled` 表示插件关闭；连接器运行但连接离线才需要检查原浏览器扩展。宿主失败不能靠重新安装或配对扩展解决。日志只作为补充，先核对时间和所属 App/CLI 实例，不用旧日志推断当前连接状态。

配对码仅用于手动连接或远程 Agent 配对。用户在目标 Agent 的 CLI 输入 `/browser pair chrome` 或 `/browser pair edge`，也可在桌面设置的手动配对入口生成本机配对码，然后直接粘贴到目标浏览器的 CardBush Browser Use 扩展；使用 CLI 生成时保持该 CLI 开启。配对码不得发给模型。远程 Agent 独立管理连接，不继承本机 App/CLI 的连接。五分钟有效期仅限制新配对码的首次接受，成功连接不会在五分钟后失效。

桌面设置入口为「设置 → 浏览器 → Browser Use」，CLI 可通过 `/settings` 检查插件启用状态。扩展随应用提供，在 `chrome://extensions` / `edge://extensions` 加载；Chrome、Edge 和不同用户配置首次分别确认，可同时连接。升级后重新加载原扩展，保留已有连接和网站授权。

关闭连接器保留配对，再次开启后自动重连；明确关闭扩展连接则需用户点击连接恢复。移除一条连接只撤销对应配对，移除连接器配置才撤销全部配对。已保存的站点/全部网站授权重启后仍有效，可在扩展中撤销；个人标签仍需明确复制进会话组。不要自行读取凭据文件、Cookie 或密码数据库。连接器不可用时说明需要的连接或授权，避免自动启动新的浏览器配置。

高级远程调试模式仍只面向用户主动开启调试的 Chrome；其工具以当前发现结果为准，不保证包含连接器的 `list_browsers` / `select_browser`。保持用户选择的模式，不静默切换。
