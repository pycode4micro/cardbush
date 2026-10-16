# 创作画板

创作是一个通过 Agent 装配的多文件空间。侧栏管理画板，主区域显示内容，下方输入连接原有会话、模型、权限和工具栈。创建画板时只分配默认任务工作区，第一次真实发送时才创建会话。界面不提供项目/临时文档分类。

## 内容与布局

`space.canvas.json` 是画板事实源，使用 `cardbush-canvas` v1 格式。画板宽高、背景、内容项的稳定 ID 与 CSS 像素坐标都保存在文件中。内容按数组顺序从后向前绘制。

- `html`：复用组件的隔离 HTML 沙盒，支持自包含 CSS、JavaScript 和 data 图片，不开放宿主权限或网络。
- `markdown`：内联 Markdown，文件引用以画板目录为基准解析。
- `file`：绝对路径、画板相对路径或网页 URL。复用右侧预览适配器，支持 PPT/PPTX、XLS/XLSX、DOC/DOCX、Markdown、PDF、HTML、图片、音视频等；未知类型显示原有文件回退入口。

本地文件修改后只刷新对应预览。改变其他内容的位置或画板名称不会重载交互 HTML。画板边界、点阵和内容轮廓区分工作区与每个内容块；标题条可直接拖动，选中后显示八个缩放手柄及尺寸，手柄大小不受画板缩放影响。

拖动空白处可平移视野；手形按钮支持在文件上方平移，中键或聚焦画板后按住空格也可平移。滚轮在空白处平移、Ctrl/⌘ + 滚轮围绕鼠标缩放，“适应窗口”恢复居中；文件内部保留自己的滚动与交互。

移动和缩放时，内容边缘、中心线与画板边界在 6 屏幕像素内吸附，并显示对齐线；Alt 暂停吸附。聚焦标题条或缩放手柄后，方向键微调 1 像素，Shift + 方向键调整 10 像素。Esc 取消当前拖动。仅在位置或尺寸真实改变后保存；拖动过程中出现新的清单版本时拒绝覆盖。平移视野不会写入布局，拖动预览也不会重载文件或交互 HTML。

## Agent

画板会话保留 `creation_workspace` 标记，并增加 `creation_canvas` 清单路径。每次发送时附加隐藏的编辑上下文：当前布局、选中项、可视区域尺寸和缩放。普通用户气泡不显示这些内部数据。

内置 `design` 工具提供两个动作：

1. `inspect`：读取清单，返回完整内容、SHA-256 版本、位置尺寸和重叠关系。
2. `update`：携带 `expected_revision`，批量 `upsert` 完整内容项、`remove` 项目，或修改画板尺寸、标题和背景。原内容 ID 可复用；删除与更新同一 ID 会被拒绝。

内容生成与原文件编辑仍由已有工具、插件负责。`design` 调用普通文件工具，保留权限检查、变更记录和恢复能力。它与桌面保存共享文件锁，版本不符时拒绝覆盖。非法尺寸、越界内容、重复 ID 和超过 8 MiB 的清单会在写入前失败。

## 局部引用、组件与保存

在文件内容上选择“引用局部”，可悬停选择内容块或拖动选择区域，再选择“引用到画板”。当前局部引用为**快照**，记录原文件、页码/工作表/单元格、定位信息与文字；不是随原文件自动更新的裁切视图。选区也能直接发送到同一 Agent 会话。

“更多”菜单支持将所选内容提取到组件、将画板用于新会话布局，以及保存到文件夹。HTML 组件保留自身交互；文件转组件使用当前可见快照，沿用组件大小及数量限制。会话布局保留系统输入组件。

导出创建一个新的独立目录，保存清单及引用的本地文件，并递归复制显式 HTML/CSS/JS/Markdown 资源依赖，重写为相对路径。外部网页继续联网访问；动态计算出的资源路径需要生成方自行提供完整资源。`index.html` 可浏览 HTML、图片、PDF 和音视频；Office 文件及完整画板请在 CardBush 中打开 `space.canvas.json`。不覆盖目标目录已有文件。

旧创作文档首次迁移为文件或 Markdown 内容项，原存储保留。Team 的文档编辑器继续使用原有实现。

## 验证

```powershell
npm run build --workspace @cardbush/bush-protocol
npm run build --workspace @cardbush/bush-runtime
npx tsc -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.json
npx vite build
node --test packages/bush-runtime/test/design.test.mjs scripts/test-creation-canvas.mjs
node --test scripts/test-canvas-geometry.mjs
node scripts/test-creation-canvas-ui.mjs
node scripts/test-inspector-regions.mjs
```

界面测试使用隔离配置和真实文件预览、真实 `design`/文件服务；对话网络调用使用桩，不产生模型调用或访问用户历史。
