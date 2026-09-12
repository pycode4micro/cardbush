# 文件预览维护入口

Inspector 根据已注册的预览能力选择显示方式。未注册的格式显示文件名、路径和“用系统默认应用打开”按钮，不读取内容、不尝试文本解码、不创建网页预览，也不会自动启动外部软件。无后缀文件只有注册过的文件名（例如 README、Makefile）才自动作为文本显示。

## 添加支持

1. **复用已有预览器**：在 `src/features/inspector/filePreviewRegistry.ts` 的 `filePreviewAdapters` 中维护扩展名或完整文件名、预览器和资源地址。匹配不区分大小写，以解码后的本地路径为输入。注册重复的扩展名、文件名或 ID 会报错，避免顺序改变导致预览器被覆盖。
2. **新增软件的专用预览器**：实现一个接收 `InspectorFilePreviewProps` 的组件，在 `src/features/inspector/inspectorFilePreviewRenderers.tsx` 注册，然后声明它实际支持的格式。渲染器类型由该映射推导，无需在 `InspectorWebview` 增加格式分支。体积较大的实现用 React.lazy 延迟加载。
3. 组件通过 `onLoadingChange` 报告加载状态，清理过期请求和资源。预览解析失败可以使用 `FilePreviewFallback` 显示原因和外部打开入口。局部异常由现有 `InspectorErrorBoundary` 处理。不要调用整应用 reload。

这是源码内的维护接口，不是允许文件或模型注册任意执行代码的动态插件 API。支持某个新格式需要真正的预览实现，仅增加扩展名不会使软件工程文件自动变成图片或网页。需要本地转换器时，在现有主进程文件服务边界增加受限的只读接口；不要把转换器运行能力放进网页或解码器。

## 职责边界

- 格式注册表：UI 选择预览器的唯一入口，不对文件内容或关联软件是否安装作推断。
- 主进程文件服务：继续负责读取、字节范围和已有 Office 解析器的输入校验。它不是 UI 的第二张格式选择表。
- 文本解码器：只处理已选择的文本预览。编码校验、读取大小上限和二进制字节检查仍保留，以防文件损坏或二进制文件被改名为 `.txt`。无需为每种新软件在解码器中追加魔数。
- 普通网页地址继续使用浏览器。系统打开失败显示弹窗，不导航或刷新主界面。
- 助手发言中的文件、文件夹路径只在最终答复完成后解析为可点击引用；流式发言、中间轮（包括展开历史）、失败和停止状态保留文字，不查询文件元数据。用户引用、附件与工具输出保持各自的展示行为。这是 `MessageBubble` 的渲染策略，不修改模型上下文或历史内容。Markdown 组件身份不随正文增量变化，避免已解析路径反复卸载、闪烁。

## 回归

运行 `npm run test:markdown-preview`、`npm run test:text-preview`、`npm run test:app-views`、`npm run test:inspector-media`、`npm run test:model-preview` 和 `npm run typecheck`。新增格式需覆盖匹配与不匹配的路径；新增预览器还需覆盖成功、格式错误、切换文件时的过期返回和资源清理。

Electron 图形测试顺序执行。本机并行运行两套图形回归时曾在断言完成后出现进程退出超时，顺序重跑通过；这不作为忽略超时的理由，测试启动器仍要求正常退出。

## Blender 只读适配器

`.blend` 已注册到独立的 `model-preview.html` 页面，复用 sandbox webview，不把 Three.js/WebGL 加载到主界面。Blender 后台进程读取文件，使用官方 glTF 导出器生成临时 GLB；源码入口为 `electron/modelPreview.ts` 和 `assets/previewers/blender_preview.py`。

- 查看能力：旋转、缩放、平移、正视/俯视/适应窗口、线框与网格、对象显隐、场景切换、动画选择/播放/暂停/进度拖动、文件信息。所有操作只影响预览，不编辑或保存源文件。
- 依赖发现：优先 `CARDBUSH_BLENDER_PATH`，然后 PATH、Windows 常见安装目录及 macOS 应用目录。无需启动 Blender GUI；未安装时显示依赖提示。当前不捆绑、不自动下载 Blender。
- 只读边界：`--factory-startup --disable-autoexec` 加 `open_mainfile(..., use_scripts=False)`；不执行文件内的自动脚本。所有转换输出和脚本副本位于单独的临时目录。转换结束校验源文件状态，真实测试另以 SHA-256 验证源文件字节不变。
- 资源边界：最多同时两个转换，每次最多 120 秒；128 MiB GLB、300 万顶点、2 万节点的显示上限。加载完成立即释放临时文件，未被取走的结果 5 分钟后释放；请求取消及退出时终止后台进程。显示按需刷新，动画在页面隐藏时暂停绘制。
- 取消契约：页面为每次转换分配随机请求 ID，通过 DELETE 显式释放同一个请求；释放同时取消准备中的进程或删除已生成结果。不能只依赖 fetch AbortSignal，Electron 自定义协议处理可能继续执行。服务保留短期、限量的释放记录，防止取消先到、转换请求后到时重新启动工作。
- 展示范围：glTF 能表达的几何、PBR 材质、灯光、骨骼/形态键等动画。程序化纹理、模拟、体积、某些节点/修改器等不能保证与 Blender 渲染相同，界面说明检测到的限制；不把转换视图声称为 Blender 完整渲染。

格式能力依据：[Blender glTF 导出说明](https://docs.blender.org/manual/en/4.0/addons/import_export/scene_gltf2.html)、[Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)。
