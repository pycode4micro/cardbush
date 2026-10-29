# 窗口材质

[English](WINDOW_MATERIAL.md) · [简体中文](WINDOW_MATERIAL.zh-CN.md)

标准深浅主题的主窗口在支持时使用 Windows 原生 Mica，默认开启。「设置 → 个性化 → 窗口玻璃效果」可切换原生材质与不透明背景，无需重建窗口或刷新会话。

标题栏和导航侧栏共享带少量中性色调的 DWM 背景，聊天和设置阅读面保持不透明。效果不依赖桌面截图、壁纸副本、CSS 扭曲或额外动画循环。壁纸强调色仍可用于其他主题，但不叠画在 Mica 上。

## 参考与实现

原实现记录对本机 Codex Windows 包 `26.908.4834.0` 的只读检查：Windows 主窗口使用 `backgroundMaterial: 'mica'` 与 `backgroundColor: '#00000000'`，macOS 使用 `vibrancy: 'menu'`，不透明模式移除材质。CardBush 独立使用 Electron 公共 Windows API，不依赖 Codex 包或私有原生 API。

这是随壁纸适配的原生材质，并非 Apple Liquid Glass 的折射效果。参见 [Microsoft Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)与 [Electron 背景材质接口](https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial-windows)。

`electron/windowAppearance.ts` 负责能力选择与原生底色。`src/features/appearance/windowAppearance.ts` 仅在宿主确认适用后打开文档透明层，忽略过时主题响应，焦点／显示／页面恢复保持状态。`src/styles/windowMaterial.css` 只为确认的原生表面设置样式。

## 回退与生命周期

- Mica 要求 Windows 11 22H2+ 和可用 GPU 合成器。
- 其他系统、减少透明度、高对比度或原生 API 失败使用普通不透明主题；Windows 自己也管理非活动窗口及节能回退。
- 赛博朋克与导入的自定义主题保留自身背景。
- 重复焦点／恢复通知不重复应用未改变的材质。
- 关闭材质后，HWND 和原生内容 View 都设置不透明主题色，保留恢复时防白底处理。
- 材质失败不刷新或重建应用。

## 验证

`npm run test:window-material` 运行策略／失败测试，并在隔离原生 Electron 窗口使用真实外观 Hook 与外壳组件，覆盖透明祖先、不透明阅读面、切换主题、延迟回复、系统无障碍及特殊／自定义主题。

Windows 下还检查滚动工具按钮、打开设置和缩放后的 HWND 命中测试。空标题区必须返回 `HTCAPTION`，按钮保持 `HTCLIENT`；系统菜单保留还原、移动、大小、最小化、最大化和关闭。夹具取消菜单显示，不移动用户指针或打开可见测试窗口。

拖拽排除仅作用于 `.window-drag` 控件。全局 `button { app-region: no-drag }` 会让 Electron 42 注册离屏滚动按钮，其未裁剪矩形可能覆盖标题区，导致拖动与右键系统菜单失效。旧占位伪元素不能阻止重叠，已经移除。窗口行为仍由 Electron/Windows 管理，参见[可拖拽区域说明](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)。

`npm run preview:window-material` 打开独立交互预览，可切换深浅和玻璃／实色；不加载产品配置、Runtime、模型凭据或真实会话，关闭即结束。

原开发机记录中，Windows 11 DWM 查询确认背景类型 `2` 和深色模式，前台桌面截图确认标题栏／侧栏壁纸色调。Electron 内容截图及部分窗口截图路径不包含 DWM 背景，不能仅据此判断材质效果。该次类型检查、原生测试、App view 回归和构建通过；当时 `test-renderer-resilience.mjs` 已有无关的导航夹具过时假设。此历史说明不替代当前版本重新验证。
