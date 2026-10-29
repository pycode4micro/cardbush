# 持续使用的创作桌面

[English](CREATION_DESK.en.md) · [简体中文](CREATION_DESK.md)

创作仍使用现有 `space.canvas.json`、文件预览、区域对话和 Team，不新增项目类型或执行系统。

## 使用

- 空白画板选择“从 CardBush 开发桌面开始”，或在“更多操作”中选择“CardBush 开发桌面”。选好代码文件夹后，新桌面仍保存在默认工作区中。
- 五个初始区域是最近改动、准备发布、验证与问题、版本对照、设计与记录。初始内容明确等待更新，不生成假的进度或测试结果。
- “更新桌面”将请求放入原有输入框；可以补充要求后发送。Agent 读取代码文件夹和已有记录，按区域更新。
- 选中区域后可以讨论、固定版本或恢复更新。文件中的更细选区沿用现有预览框选和对话。
- 更多操作中的 Team 选择只关联现有流程，不自动启动或修改它。Agent 按任务为成员分配区域，并使用现有 Team 执行。
- “保存到文件夹”“提取组件”“用作新会话布局”继续使用原有导出能力。

## 内容与布局

`design inspect` 返回稳定区域 ID、内容、用途、分组、成员分工、版本模式和 revision。

更新内容使用 `content: [{id, content: {kind, markdown | html | source}}]`，不会更改位置、大小、顺序、分组、用途和分工。已有区域的坐标或画板尺寸变动需要 `layout: true`；Agent 仅在用户要求重新布局时使用。完整写入保留 revision 比较和跨进程文件锁，冲突必须重新读取，不能用旧布局覆盖新修改。

## 固定版本

`freeze` 保存独立内容版本，`unfreeze` 恢复原内容来源。两者都需要 item ID 和最新 revision。常规保存和 design 更新拒绝修改固定内容，但允许用户移动或重命名区域。

本地文件和显式资源依赖复制到 `canvas-versions/<uuid>/`；Markdown 的本地图片等同步复制，普通外链保留。捕获前后的来源内容必须一致。固定副本不依赖原文件继续存在；恢复更新时会再次引用原文件，原文件不存在则由原有预览显示缺失状态。

Markdown 资源按语法识别，行内代码、代码块、转义示例和未使用的引用定义不会被当成文件读取；实际图片、链接及引用式图片会保留正确的依赖。固定与导出使用同一逻辑。真实资源缺失时操作仍会停止，避免生成不完整的版本；界面只显示可操作的文件提示。

画布默认与“创作”标题、名称输入框、缩放控件共用左侧基线；细边框和网格标明实际可放置区域。缩放以鼠标所在画布点为锚，适应窗口后恢复对齐。提示浮层不参与尺寸计算，因此不会挤压画布或触发重新缩放。

这是文档源内容的版本，不是录制动态网页运行状态。远程文件或外部加载的媒体需先保存为本地内容，或使用现有区域截图引用；不会把远程网址标成固定文件。Agent 复制沿用标准文件工具及权限、修改记录，单文件仍有 8 MiB 限制；桌面直接操作的版本总量限制为 128 MiB / 200 个文件。原始文件与其他工具仍然独立，固定版本不是操作系统写保护。

## Team

使用已有 `team run` 的可选 `canvas_path`。启动时通过 design 校验路径并持久化区域分工；成员用各自的 design 工具重新读取最新内容，不调用已经结束的父会话回调。只读成员沿用 read_file 读取画板并返回审查结果，不放宽工具或权限限制。运行和恢复继续使用同一 Team / subagent 生命周期。

成员只能用 design 更新分配给自己的区域内容。布局、固定/解冻、删除、分工调整和跨区域变更由父 Agent 处理。没有分配区域的成员返回结果，由父 Agent 整合。共享源文件的分工仍须由父 Agent 协调，不开放子 Agent 之间的自由沟通。

## 验证

- `node --test packages/bush-runtime/test/design.test.mjs scripts/test-creation-canvas.mjs`
- `node --test packages/bush-runtime/test/teamWorkflow.test.mjs packages/bush-runtime/test/nativeTeamHost.test.mjs packages/bush-runtime/test/builtinToolDisclosure.test.mjs`
- `node scripts/test-creation-canvas-ui.mjs`

UI 回归使用真实 Electron 预览与文件服务；原生 Team 回归使用真实子会话和工具执行、确定性的模型回复。它们验证产品链路，不代表已验证任意模型的内容质量。
