# HTML 组件、浏览器收藏与多页面首版

2026-09-30。本文描述已经接入生产代码的行为。前期完整设计见 [设计文档](DESKTOP_COMPONENT_DESIGN_2026-09-29.md)，其中的后端语言适配、目录资源包、自启动等后续能力不属于本次实现。

## 使用入口

- 应用中心 → **组件**：以实际视图排列时钟、数字时钟、日历、品牌展示、欢迎语、对话引导和输入框。内置组件可以调整尺寸和位置，但不能删除或替换实现；旧配置自动补齐这些组件，保留已有自定义 HTML。
- 右上角 **自定义组件** 是唯一导入入口，接入单文件 HTML 或下述 JSON 包；组件库中的自定义组件可删除，内置定义始终保留。
- **编辑布局** 打开当前新会话首页，共用首页组件渲染。顶部浮动胶囊提供 **组件、撤回、取消、保存**；撤回右侧的小箭头展开 **重置到开始状态、清空**，清空使用红色。组件列表增减首页上的视图，悬浮拖动标题移动、拖动右下角缩放，聚焦手柄也可用方向键调整。首次调整从当前页面实际位置起步。
- **重置到开始状态** 恢复本次进入编辑器时的布局；清空只清除首页放置，内置定义和自定义 HTML 均保留。这两项都可撤回，取消不写入配置，保存后用于新会话首页；已保存的空布局不会被自动补回。多窗口版本冲突时保留草稿并报错。编辑预览禁止组件动作，精简输入预览也不改变实际权限。
- 输入框在卡片右上角选择 **标准 / 精简**，选择持久化。精简样式是单行胶囊，保留添加、模型与发送/停止；两种样式使用同一个 Composer、当前本机会话与草稿。沿用原命令、引用、Source、排队和引导链路；命令列表使用浮层，不受卡片裁切。时钟使用本机时间，日历支持切换月份和返回今天；组件不会因为展示或切换样式调用模型。
- 精简输入提示为 `let's talk`，进入精简样式默认设为完全访问，后续显式权限调整不会被重绘覆盖。精简模型菜单仅展示模型选项；标准菜单保留用量、推理强度和管理入口。所有输入框收起的模型按钮只显示模型名称，服务商与协议仅在展开列表中显示。
- 右侧空页与标签栏 `+` 菜单 → **添加页面**：输入网址打开。网址胶囊末尾的星标保存/取消收藏，两处菜单同步显示收藏，重启后保留。
- 同样两处入口 → **多页面 (Beta)**：确认大屏与 DPI 提示后进入，自动收起左栏、将会话区收至 340 CSS px，默认显示两页各占一半。分隔线调整尺寸，网址栏左侧拖拽柄交换位置，新打开的页加入布局；关闭页面使用顶部标签栏，外部打开使用顶部按钮并跟随当前选中页，页面内不重复显示标题和这两项操作。关到不足两页时退出编排并恢复原宽度。
- 任意右侧内容都可将左边界拖至应用最左侧，覆盖顶部动作栏以下的内容区。双击边界或聚焦边界按 Home 也可进入。浮动胶囊提供返回与输入；返回恢复原会话/功能页和侧栏状态。
- 快速输入复用原 Composer，仅隐藏工具栏和模型选择等选项；仍走原有引用、命令、发送、排队、引导、停止链路。云端 Agent 页面继续使用该远程会话的 Composer，不切到本机 Runtime。Escape 先处理已打开的命令菜单，再关闭快速输入，最后返回普通布局。

多页面布局仅随当前窗口生命周期保留，不会自动恢复网站列表或启动任务。页面使用实际视口尺寸自行响应布局，不缩放网页字体或整体截图。编排交换位置保持原浏览器实例，文件、Shadow、子代理等仍使用各自现有渲染器。

原生网页的输入事件不会冒泡到外层 React，激活页由 Electron 主进程的 guest 焦点/鼠标通知同步，防止快捷键操作到上一页。对应行为依据 [Electron webview 文档](https://www.electronjs.org/docs/latest/api/webview-tag) 与 [webContents 事件文档](https://www.electronjs.org/docs/latest/api/web-contents)。

## 导入格式与权限

HTML 包含内联 CSS/JavaScript，可使用 data 图片；单个 HTML 上限 256 KiB，最多 12 个自定义组件，内置组件不占此额度。JSON 包格式：

```json
{
  "protocol": "cardbush.html-surface/1",
  "title": "我的组件",
  "html": "<main>...</main>"
}
```

导入窗口中的 **允许调用会话和浏览器动作** 默认关闭，包不能自行授予权限。HTML 在 `sandbox="allow-scripts"` 的 opaque-origin iframe 中运行，不能读取宿主存储、Electron API 或密钥。CSP 限制资源与网络；Electron 现有 `sandboxFrameGuard` 阻止子框架跳离受控文档。编辑布局期间业务动作被拒绝。

这是能力与文档隔离，不是独立操作系统进程。当前不提供任意 shell/Python 执行、外部资源目录、外部网络白名单或第三方站点的宿主桥接。远程网页继续使用原浏览器。

## 组件 SDK

宿主在用户脚本之前注入 `window.cardbush`。跨帧协议是 JSON-RPC 风格的数据消息，协议版本为 `cardbush.html-surface/1`，绑定 frame window、opaque origin 与每次装载随机 token。TS 宿主处理动作，协议本身不依赖后端语言。

| API | 作用 |
| --- | --- |
| `await cardbush.ready` | 等待宿主上下文，含 `revision`、`sessionId`、`language`、`running` |
| `await cardbush.read()` | 读取当前上下文，不发模型请求 |
| `cardbush.subscribe(topic, callback)` | 订阅事件，返回取消订阅函数 |
| `await cardbush.state.read()` | 读取该实例的本地 JSON 状态 |
| `await cardbush.state.write(value)` | 保存状态，每实例最多 16,000 UTF-8 字节 |
| `await cardbush.invoke(command, args, key?)` | 调用已授权动作，可指定幂等键 |

事件包括 `host.context`、`host.visibility`、`host.resized`、`theme.changed`。不传模型中间 loop、历史正文或密钥。尺寸事件给出 iframe 的 CSS 像素宽高；每次应用主题改变推送相应变量，页面无需重载。

当前动作：

| command | args | 成功回执 |
| --- | --- | --- |
| `composer.fill` | `{ text }` | `{ status: "applied" }`，填入当前输入框并打开会话 |
| `conversation.send` | `{ text }` | `{ status: "accepted" }`，交给当前会话的原发送逻辑 |
| `browser.open` | `{ url }` | `{ status: "opened" }`，打开 HTTP/HTTPS 页面 |

`accepted` 表示本机发送逻辑已接收调用，不代表服务端收件或模型任务完成。宿主先校验 Runtime 和模型配置，再异步交给原发送链路，避免组件等待整轮思考而超时；后续发送失败仍在原会话反馈。布局、主题、读取状态不会调用模型；只有显式动作进入原发送路径，不新建 system prompt、不改 Source、引用或 cachechain 格式。动作绑定当前会话上下文，旧会话请求返回 `STALE_CONTEXT`。发送后开启新会话造成的上下文变化也会使旧动作失效。

同一组件装载期间，同一上下文与幂等键的相同动作共享结果；不同参数报 `IDEMPOTENCY_CONFLICT`。保留至多 128 次动作，不在淘汰后悄悄重发；超过后提示 `ACTION_LIMIT`，需重新载入。并发请求最多 8 个。SDK 等待 30 秒超时后明确提示结果未知，不自动重试；跨重载不保证 exactly-once。

主题变量：`--cb-background`、`--cb-surface`、`--cb-text`、`--cb-muted`、`--cb-border`、`--cb-accent`、`--cb-font`、`--cb-code-font`、`--cb-font-size`、`--cb-color-scheme`、`--cb-reduced-motion`。使用继承样式或这些变量才能随主题改变；宿主不会重写作者硬编码的颜色。减少动画跟随应用设置。

最小 HTML 示例（点击才发起动作）：

```html
<style>
  body { color: var(--cb-text); background: var(--cb-background); }
  textarea { width: 100%; min-height: 90px; }
  small { color: var(--cb-muted); }
</style>
<textarea id="text" placeholder="写下想交流的内容"></textarea>
<button id="send">发送到当前会话</button>
<small id="status"></small>
<script>
  const input = document.querySelector('#text');
  const button = document.querySelector('#send');
  const status = document.querySelector('#status');
  button.disabled = true;
  cardbush.ready.then(async () => {
    input.value = (await cardbush.state.read())?.draft || '';
    button.disabled = false;
  });
  input.onchange = () => cardbush.state.write({ draft: input.value });
  button.onclick = async () => {
    button.disabled = true;
    try {
      await cardbush.invoke('conversation.send', { text: input.value });
      status.textContent = '已提交';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
</script>
```

## 验证记录

### 日历与定时页统一

- 内置日历和定时页共用 `CalendarMonthGrid` 日期视图及 `useCalendarDayDetails` 浮层。月份格子只显示日期、今天状态和安排圆点，节日、农历、导入日程与自动化时间/次数在悬浮或键盘聚焦时显示；点击日期可固定浮层，Escape 关闭。定时页年视图的日期也支持悬浮。
- 组件使用现有 `calendarCommand/list`、`automationCommand/list` 的数据快照与变更通知；节日/农历沿用用户当前启用的日历。多个组件共享一份自动化订阅，悬浮不发起额外请求、不创建或执行任务。预览与布局编辑保持不可交互。
- 定时页移除月视图的常驻当天详情，搜索与刷新/新建合并成一行。浮层中的“查看当天安排”进入日视图，保留编辑、执行记录和计划管理能力；日/月/年跳转、搜索、导入和通知仍沿用现有逻辑。
- 详情使用原生 top layer 避免被组件边界裁切，按视口定位，内容较多时可滚动。已验证浅色/深色/导入主题、窄窗口、125% 组件缩放、鼠标移入浮层不闪退、Escape 返回日期、任务更新与日历开关同步，以及只读访问。

### 布局编辑交互补充

- 移动与缩放统一使用画布的逻辑坐标，保留鼠标抓取位置并计入缩放、滚动；组件内容区域也可直接拖动。鼠标松开提交一次撤回记录，Escape、失焦和指针取消恢复操作前布局。
- 编辑工具栏新增拖动手柄，可放在内容区域下方，窗口变窄时自动约束位置；低位工具栏的菜单向上展开，预览避让取消/保存按钮。
- 移动与缩放提供页面边界、中心及其他组件边缘/中心的对齐线，6 个屏幕像素内吸附；按住 Alt 可暂时自由调整。
- 组件列表支持悬浮与键盘聚焦预览，复用内置组件和 HTML 渲染。预览不可交互、不抢输入焦点、不发送模型动作，也不写入自定义组件状态；主题继续跟随应用。
- 新增真实鼠标回归：125% 下首次拖动默认页、已保存组件拖动/缩放、拖动时滚动、吸附和 Alt、Escape 恢复、工具栏下移/窗口收窄、菜单展开与预览边界。键盘聚焦事件在隐藏 Electron fixture 中显式派发；无模型请求。

- TypeScript 类型检查与 Vite 生产构建通过。
- `node --test scripts/test-html-components-layout.mjs scripts/test-app-center.mjs`：分区覆盖/无重叠、半宽起始、URL 校验、组件格式/权限、应用中心目录。
- `node scripts/run-app-views-test.mjs html-components`：真实 iframe SDK、主题更新、授权拒绝、陈旧上下文、重复动作去重、编辑禁用动作、导航拦截、收藏与菜单；内置视图、时钟更新、闰日月历、唯一自定义入口、两种输入样式与模型菜单、权限默认值、命令浮层、IME/发送/停止；真实首页编辑、胶囊菜单、组件增减、撤回/重置/清空/取消/保存、真实指针缩放、保存后首页渲染、空布局持久化和版本冲突。
- `node scripts/run-app-views-test.mjs inspector-cover`：真实指针将边界拖到最左，使用完整 viewport/content 容器验证单页与多页铺满、窗口变宽/变窄与 125% 渲染缩放、窄窗口拖拽柄可用；动作栏保留、原 Composer 单实例、焦点/草稿/IME/命令/发送/停止，以及返回恢复原宽度。
- `node scripts/run-agents-ui-test.mjs --quick-input`：真实云端界面与隔离服务替身，验证胶囊发送仍路由至原 Agent/会话，远程接收后清理草稿，返回恢复同一输入框。
- `node scripts/test-inspector-browser-navigation.mjs`：真实 Electron webview 的单行拖拽柄/网址栏、两页半宽、覆盖/返回时实际视口适配、真实鼠标换位与失焦取消；全局外部打开跟随点击页及其重定向后网址（记录 IPC，不启动外部浏览器）；webContents ID/页面状态保持；既有导航、主页、延迟页面回归。
- `node scripts/test-inspector-navigation-ui.mjs`：既有文件、浏览器、Shadow、审查、历史和子代理页面回归。
- `node scripts/run-app-views-test.mjs app-center` 与 `composer-input`：既有应用中心操作、真实中文输入法、引用 token、发送和窄窗口输入回归。

测试使用隔离 profile 和本地页面/替代发送回调；没有向真实模型发送验证消息。真实跨显示器 DPI 与全套 100%/125%/150%/200% Windows 环境尚未完成，故多页面保留 Beta 提示。
