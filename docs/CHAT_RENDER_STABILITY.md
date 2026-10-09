# 工具更新时的会话稳定性

2026-09-13 排查的场景是：已有说明文字和大图，连续收到无新正文的工具排队、运行、完成事件，视口随每次事件上下跳动。

## 日志证据

开发目录 `logs/window-scroll.log` 的 2026-09-13 04:47:51 UTC 记录显示，同一 `assistant-message-content` 节点的 `assistant-thinking-process` 被移除后再次加入，滚动内容高度在 2578 与 2547 像素之间往返。消息节点保持连接。后续贴底状态下的记录中，内容高度 3183/3152 与 scrollTop 2508/2477 同步变化，标题栏和输入框尺寸不变。

这说明已捕获的问题来自状态行改变布局高度，贴底跟随后扩大为整个视口的位移。React 再次执行渲染函数本身不等于页面刷新，也不能仅凭组件 render 次数判断抖动。

## 渲染方式

- 活动回合底部保留一个状态行，在原位置切换排队、运行、等待授权/方案选择和思考文字。它独立于各段文字与工具包，新增回合片段时也不需要迁移旧媒体。
- 每个已挂载的消息/历史组件单独拥有媒体投影缓存。工具状态、日志文本和不带产物的新工具不会生成新的媒体 Context 值。
- 未变更的正文块及媒体组件使用 memo；新增或补全产物时保留其余预览的对象身份。路径映射、产物删除与真实内容变化仍会更新，缓存不跨会话共享。
- 保留原有的消息身份、工具归属、排序、展开状态和用户手动脱离贴底的行为。

## Codex 参考范围

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 明确说明按 Thread / Turn / Item 组织数据，用 `item/started`、`item/completed` 和各类 delta 通知增量进度。文档没有承诺桌面端的具体 DOM 实现。

本机 Codex 26.908.4834.0 的只读资源检查另见 `thread-virtualizer` 和 `local-conversation-thread` 模块：按 turnKey 记录测量高度、用锚点补偿距底部距离、通过 ResizeObserver 收集尺寸变化，渲染块含编译后的缓存比较。本次借鉴稳定身份、局部更新与几何验证；没有复制这些模块，也没有为本问题替换整套列表实现。

## 回归

`npm run test:chat-tool-updates` 在隔离 Electron 中挂载真实 ChatPanel 与流更新函数，以 1280×720 图片和连续工具事件逐帧采样。深浅主题均检查内容高度、图片坐标、DOM 连通性和重复 load 次数，同时验证手动阅读历史、展开工具和迟到结果。该测试禁止网络与模型调用，不操作用户会话。

`scripts/test-media-presentation.mjs` 覆盖媒体 Context 身份复用、产物新增/补全/删除、路径映射和会话隔离；原有流追加、工具分组和会话滚动测试继续覆盖其余交互。

## Assistant 气泡跟随与输入框遮罩（2026-10-08）

隔离 Electron 复现确认：同一用户输入先收到长回复、再收到短回复时，旧定位仍选第一条 assistant 消息。新气泡顶部在 1471px，可视区为 48–800px，距离底部仍有 915px。另一个入口是普通 `pointerdown` 被当成手动滚动，从而关闭后续跟随。

现在每次新回复按最新气泡定位：短回复完整显示，超出阅读区的回复显示开头，空间允许时保留附近的用户提问。消息插入与 Markdown 后续测量都在绘制前完成定位；普通点击、底部向下滚动不取消跟随。上翻历史、拖动滚动条、触摸滚动和文本选择仍保留用户位置。自定义固定输入框布局继续使用原有定位规则。

输入框渐变仍覆盖正文和两侧空白，但延伸范围减去原生滚动条宽度；主会话、assistant 和嵌入子会话共用此边界。

诊断复用会话级开关：在应用渲染进程控制台执行 `sessionStorage.setItem('cardbush_scroll_debug', 'true')`，复现后查看 `window.__cardbushScrollDebug` 中 `assistant-viewport` 条目，或现有 `scroll` 调试日志。条目包含消息 ID、跟随状态、视口/内容高度、目标与实际滚动位置，不记录消息正文。内存只保留最近 300 条；执行 `sessionStorage.removeItem('cardbush_scroll_debug')` 可关闭，不写持久设置。

`CARDBUSH_ASSISTANT_UI_CASE=scroll node scripts/test-assistant-ui.cjs` 输出几何日志及深浅主题截图，覆盖新回复首帧、同轮多次回复、长提问、迟到布局、普通点击、手动阅读和恢复跟随。`node scripts/run-app-views-test.mjs composer-backdrop` 验证主/子会话的遮罩边界。
