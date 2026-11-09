# 主页自定义组件

创建、导入、编辑与发布见 [CardBush 使用指南](../assets/skills/cardbush-docs/references/home-components.md)。

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

`npm run test:composer-layout` 覆盖布局选择的默认值、校验与优先级，以及真实界面的首条发送、上方内容避让、下方堆积、顶部吸附、流式与草稿稳定、会话滚动恢复、切回默认布局、保存重开和窄窗口。输入框专项同时验证标准/精简样式发送前后同轴同宽、保持位置、近底部吸附、默认页落点一致、125% 真实指针水平锁定/对称调宽、键盘限制、底部锚点持久化和小窗口固定。编辑器与首页布局回归继续保留。

### 日历组件与悬浮详情

- 日历保留在组件中，定时页移除日历并默认打开计划管理；旧日历导航回退到计划管理。节日开关和 JSON / ICS 导入移至组件右上角的日历设置，现有数据继续保留。
- 日期格只显示日期、今天状态和安排圆点。悬停 180 ms 展示详情，键盘聚焦或点击立即打开；点击固定，Escape 返回日期。卡片最多 300 × 300 CSS px，受视口约束，标题固定、内容内部滚动，采用 120 ms 淡入淡出，并遵循减少动态效果设置。
- 组件继续使用已有日历/自动化快照与变更通知；多个组件共享自动化订阅。悬浮不额外请求、不执行任务；预览与布局编辑保持不可交互。
- 已验证实际鼠标悬停/快速扫过、进入卡片、固定/退出动画、内部滚动、节日导入和独立开关、实时任务更新、Escape、减少动态效果及 125% 窄窗口。定时页的编辑、执行、停止、读状态和来源会话跳转回归保留。

### 布局编辑交互补充

- 输入框属于特殊布局组件：编排、首页与会话共用水平居中和宽度计算；只允许上下移动、围绕中轴对称调宽，高度跟随真实内容。左右拖动、左右移动快捷键、Alt 均不会改变中轴；其他组件仍可自由布局。
- “自动移到底部”在编排画布中展示实际落点。按当前视口高度采用 120–160 CSS px 最小移动距离，靠近落点直接吸附；小窗口或输入框过高时优先固定到底部。保存吸附状态后随窗口高度调整，首条发送仅在距离足够时执行纵向过渡，并尊重减少动态效果设置。“保持当前位置”发送时保留实际输入框位置。
- 画布底部固定显示可视区域底线与布局高度提示。组件超出一屏时显示超出的 CSS 像素并提示上移或缩小；随拖动、缩放、撤回和窗口大小更新，不依赖滚动条是否显示。提示是覆盖层，不占用画布高度，不拦截组件操作；拖动时为防止跳屏保留的临时画布高度不计入超限。

- 移动与缩放统一使用画布的逻辑坐标，保留鼠标抓取位置并计入缩放、滚动；组件内容区域也可直接拖动。鼠标松开提交一次撤回记录，Escape、失焦和指针取消恢复操作前布局。
- 编辑工具栏新增拖动手柄，可放在内容区域下方，窗口变窄时自动约束位置；低位工具栏的菜单向上展开，预览避让取消/保存按钮。
- 组件操作条按可视画布定位，上方空间不足时翻到下方，并随滚动与缩放约束边界。默认工具栏优先占用组件外的空位，拖动组件或打开菜单时保持稳定；用户手动放置工具栏后保留其位置。浮层调整不改变组件坐标、宽度或已保存布局。
- 移动与缩放提供页面边界、中心及其他组件边缘/中心的对齐线，6 个屏幕像素内吸附；按住 Alt 可暂时自由调整。
- 组件列表支持悬浮与键盘聚焦预览，复用内置组件和 HTML 渲染。预览不可交互、不抢输入焦点、不发送模型动作，也不写入自定义组件状态；主题继续跟随应用。
- 新增真实鼠标回归：125% 下首次拖动默认页、已保存组件拖动/缩放、拖动时滚动、吸附和 Alt、Escape 恢复、工具栏下移/窗口收窄、菜单展开与预览边界。键盘聚焦事件在隐藏 Electron fixture 中显式派发；无模型请求。

- TypeScript 类型检查与 Vite 生产构建通过。
- `node scripts/run-app-views-test.mjs composer-presentation`：实际 ChatPanel 从首页发送进入对话、发送/停止、布局优先级、模型菜单、草稿与显式权限保留、重新挂载、嵌入及窄面板、覆盖模式快速输入。
- `node --test scripts/test-html-components-layout.mjs scripts/test-app-center.mjs`：分区覆盖/无重叠、半宽起始、URL 校验、组件格式/权限、应用中心目录。
- `node scripts/run-app-views-test.mjs html-components`：真实 iframe SDK、主题更新、授权拒绝、陈旧上下文、重复动作去重、编辑禁用动作、导航拦截、收藏与菜单；内置视图、时钟更新、闰日月历、唯一自定义入口、两种输入样式与模型菜单、权限默认值、命令浮层、IME/发送/停止；真实首页编辑、胶囊菜单、组件增减、撤回/重置/清空/取消/保存、真实指针缩放、保存后首页渲染、空布局持久化和版本冲突。
- `node scripts/run-app-views-test.mjs inspector-cover`：真实指针将边界拖到最左，使用完整 viewport/content 容器验证单页与多页铺满、窗口变宽/变窄与 125% 渲染缩放、窄窗口拖拽柄可用；动作栏保留、原 Composer 单实例、焦点/草稿/IME/命令/发送/停止，以及返回恢复原宽度。
- `node scripts/run-agents-ui-test.mjs --quick-input`：真实云端界面与隔离服务替身，验证胶囊发送仍路由至原 Agent/会话，远程接收后清理草稿，返回恢复同一输入框。
- `node scripts/test-inspector-browser-navigation.mjs`：真实 Electron webview 的单行拖拽柄/网址栏、两页半宽、覆盖/返回时实际视口适配、真实鼠标换位与失焦取消；外侧边框拖动全程保持左右区域相邻，验证松手最终坐标、靠左停留及覆盖返回、125% CSS/渲染缩放、内部行列分隔线抓取偏移与失焦恢复；全局外部打开跟随点击页及其重定向后网址（记录 IPC，不启动外部浏览器）；webContents ID/页面状态保持；既有导航、本地新标签页、Google 搜索、延迟页面回归。
- `node scripts/test-inspector-navigation-ui.mjs`：既有文件、浏览器、Shadow、审查、历史和子代理页面回归。
- `node scripts/run-app-views-test.mjs app-center` 与 `composer-input`：既有应用中心操作、真实中文输入法、引用 token、发送和窄窗口输入回归。

测试使用隔离 profile 和本地页面/替代发送回调；没有向真实模型发送验证消息。真实跨显示器 DPI 与全套 100%/125%/150%/200% Windows 环境尚未完成，故多页面保留 Beta 提示。
