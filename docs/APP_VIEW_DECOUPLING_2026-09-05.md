# App 视图解耦：第二批

基线：`9a5bb05`。该 commit 已包含第一批消息投影解耦和此前的 UI/Runtime 修复；本批在其后继续拆分，不改变业务行为。

## 已完成

- `src/App.tsx` 从约 8,200 行缩至约 4,240 行，保留根状态、会话/项目切换、Inspector 标签管理和回调装配。
- `features/chat/ChatPanel.tsx` 接管聊天展示、消息列表和滚动/占位逻辑。整个组件及其 Hook 顺序原样搬迁，不新增状态管理器、Context 或额外渲染层。
- `features/chat/WelcomeComposer.tsx` 接管欢迎页及项目切换菜单；菜单状态仍只属于该组件。
- `features/chat/ChatStatusViews.tsx` 接管加载、重试提示和连接恢复提示。
- `components/TopBar.tsx` 被聊天区和普通功能面板复用，保持原有按钮可见性和回调参数。
- `features/interactions/InteractionCard.tsx` 接管交互卡片，不修改权限或用户答复协议。
- `features/inspector/InspectorWebview.tsx` 接管浏览器与 Markdown/源码预览的生命周期；`inspectorTargets.ts` 负责地址分类、归一化及预览地址生成。
- `shared/cssEscape.ts` 承接根组件和聊天区共用的小型选择器转义函数，避免子模块反向依赖 App。

## 保持不变的边界

- 没有改动 Runtime、API、事件协议、持久化字段或真实会话数据。
- 根组件仍持有会话、项目和标签状态；没有因为文件拆分增加一次异步加载或新的卸载/挂载边界。
- 聊天消息 key、原生滚动容器、用户手势脱离跟随、提交占位、停止后展示和草稿流转保持原样。
- Inspector 的 ready 检查、异步测量修订号、文件读取取消标志和加载回调保持原样。
- 原有源码高亮懒加载与开发环境 pre-test 开关保留。只改了移动后对应的相对导入路径。
- UI 对 `useCardbushChat` 的队列类型引用使用 `import type`，不把该 Hook 引入视图运行依赖。

## 核对和回归

1. 以基线 App 的 TypeScript 顶层声明为单位逐项比较：共 110 项，36 项移入新模块、74 项留在 App。忽略新增的 `export`、换行格式和两处等价动态导入路径后，110 项实现一致，包括完整的 `CardbushApp` 与 `ChatPanel`。
2. 原有 48 项契约脚本全部通过。13 个跨视图契约改为通过 `scripts/helpers/app-view-sources.mjs` 读取实际模块；原有断言未删减。
3. 新增 `npm run test:app-views`，使用真实 React 组件和隔离的 Chromium 窗口，检查：
   - 视图不能反向依赖 App；拆出模块不能形成循环依赖。
   - React 开发模式的 StrictMode 重复挂载和清理。
   - 旧文件读取晚于新文件返回时，不覆盖当前预览，也不回写旧导航状态。
   - 预览重载、文件切换、读取错误、卸载后的迟到结果、源码高亮懒加载。
   - 欢迎页隐藏会话专属按钮，审查回调不接收 React 点击事件作为文件路径。
   - 历史加载 → 项目欢迎页 → 会话；菜单 Escape；同会话更新不重新挂载列表；开始/停止后保留消息；切换会话不串内容。
   - 地址规范化和 Office 预览路由。
4. 消息投影/缓冲测试与 Inspector 标签真实交互测试通过。
5. Runtime 核心测试 204/204 通过。
6. UI/Electron TypeScript 检查、Vite 生产构建及生产包清理契约通过。仍有既存的大 chunk 提示，本批不声称改善了包体积或运行性能。

本批组件测试使用合成消息和内存文件读取结果，禁用网络调用；没有付费模型请求，也不覆盖真实 Electron 网页服务的端到端验证。

## 暂未继续拆的部分

`ChatPanel` 仍约 2,700 行，主要是滚动/占位及大量现有属性；`CardbushApp` 内部仍有设置和 Inspector 管理逻辑。下一批可分别处理设置读写和 Inspector 控制逻辑，聊天滚动应作为独立专项逐步拆出。不要以减少行数为由把状态和副作用同时重写。
