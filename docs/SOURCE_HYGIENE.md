# 模板、语言包与下线代码检查记录

日期：2026-11-06。检查基线：`2e1da1a16fdd404d2d217bf2a22a50bd33c22c24`。

## 检查范围与方法

对仓库跟踪文件进行清单检查，覆盖 `src`、`web`、`electron`、`packages`、`scripts`、`assets`、`native` 和部署入口。结合静态引用、字符串构造的动态入口、工作区导出、构建/打包脚本和实际测试判断是否仍在使用。静态扫描得到的“无引用”只是候选，不能直接视为可删除代码。

本次在独立工作树修改和验证。主工作树已有的 AgentChatRoom 生成产物、Chrome Connector 安全实现、凭据安全测试未纳入本次提交。未修改用户配置、连接、语言偏好和真实运行数据。

## 模板与语言包

- `AGENTS.md` 增加模板与执行逻辑分离、语言包注入、资源随发行包交付，以及下线代码的删除证据要求。
- 模型管理的请求和状态保留在 `web/ModelAdmin.tsx`；表单布局迁到 `web/templates/ModelAdmin.template.tsx`，共享选项和默认值迁到 `model-form.json`。模板接收类型化的数据和回调，继续使用 React 的转义与事件机制。
- Web 登录、会话、组织、模型、插件和远程 Agent 管理的界面文案接入共享语言包及语言上下文，移除固定中文参数。新增语言选择器，切换时保留表单草稿；管理页面的成功提示保存消息键、渲染时翻译。
- 文本预览、Office 预览、Office 交互脚本、画布导出和 OAuth 回调页迁到 `assets/templates`。构建后资源包含在平台包 ESM/CJS 产物中，不依赖源码路径和启动目录。
- 模板渲染区分转义文本、安全 JSON 字面量和显式可信 HTML 片段；缺少、多余变量报错，插值不递归。原始文件内容、外部服务错误、路径和协议标识保持数据语义。
- 中英文分别新增 370 个消息键，移除各 45 个已下线专用消息键。源码约束检查补上此前遗漏的 `web` 目录。

固定页面外壳已经抽离；Office 文档内容的动态布局、导入文件几何数据和 React 运行逻辑仍由对应渲染器负责。此记录不声称第三方内容、后端全部错误或历史诊断脚本已经全面本地化。

## 已删除的 16 个文件

| 文件或分组 | 删除依据 |
| --- | --- |
| `src/features/agents/AgentDesktopView.tsx` | 旧远程桌面视图已无产品入口，只有旧构建断言提及文件名 |
| `src/features/agents/agentDesktop.css` | 仅被上述视图引用 |
| `src/features/agents/agentDesktopCoordinates.ts` | 仅供上述视图和针对该旧实现的坐标测试使用 |
| `src/features/agents/agentNavigation.ts` | 无静态或动态调用、公开导出或独立入口 |
| `scripts/helpers/agent-desktop.cjs`、`agent-desktop-live-preload.cjs` | 已退出实际 Agents 界面回归入口，仅旧桌面夹具相互关联 |
| `scripts/helpers/agent-chat-regressions.cjs`、`agent-connection-recovery.cjs`、`agent-conversation-layout.cjs`、`agent-deletion.cjs`、`agent-dialog-layout.cjs`、`agent-plugin-install-guidance.cjs`、`agent-quick-input.cjs`、`agent-session-switching.cjs`、`agent-submission.cjs`、`agent-welcome.cjs` | 旧直连 AgentChat 界面专用辅助脚本；现行测试入口不加载这些脚本 |

同步更新构建边界测试，删除仅验证旧坐标辅助函数的测试。仍在使用的桌面服务、工具边界与远程 Worker 界面回归保留并执行。

## 核实后保留的间接入口

| 候选 | 保留证据 |
| --- | --- |
| `electron/agentInteractiveDesktopCli.mts` | `scripts/package-agent.mjs` 的打包入口及桌面桥测试 |
| `src/features/chat/ShadowTemporaryChat.tsx` | `ComposerRuntimePreTest` 与 Shadow 回归 |
| `src/features/inspector/spreadsheetRegionAdapter.ts` | Vite 的 `scripts/spreadsheet-region-plugin.mjs` 注入 |
| `src/office/drawingmlChartCategories.ts`、`drawingmlGeometry.ts` | PPTX Worker 构建插件注入 |
| StreamingLab 与 history/streaming replay | 独立诊断入口、导出脚本和回归夹具 |
| `scripts/helpers/assistant-submission.cjs`、`assistant-shortcuts.cjs` | Assistant 测试入口通过计算文件名加载 |
| 协议兼容层、数据迁移、Office 兼容预览 | 已有数据、已发布协议或兼容路由仍依赖它们 |
| `cardbush-subproj-demo` | 独立实验项目，不属于产品运行时；不能因主应用无引用而推断已下线 |

其余动态消息键按键前缀和运行时组合核对，没有因缺少完整字面量引用而批量删除。

## 验证与限制

- 生产构建、桌面/Node/Web TypeScript 检查、Web 生产构建。
- `test:ui-localization`、`test:app-views`、实际 Agents 界面回归、Renderer 构建边界、原生菜单回归。
- 新增真实 Web 管理界面回归：中英文切换、草稿保留、保存及失败重试、成功提示切换、用户内容转义、390px 窄窗口、组织角色与远程 Agent 表单。
- 新增模板回归：ESM/CJS 资源一致、变量约束、脚本注入转义、中英文并发预览、OAuth 校验页与 CSP；同时运行文本预览、画布、OpenAI 登录相关测试。
- Web 通用回归 109 项通过。组织管理测试使用临时 PostgreSQL 容器和独立数据库，结束后删除容器；不使用真实组织数据。
- 平台包及 MCP 客户端共 160 项通过，1 项 POSIX 环境变量大小写测试在 Windows 按平台条件跳过。
- `scripts/test-web-plugin.mjs` 是 Linux 部署集成测试，依赖 `/opt/cardbush-python` 及 `dir_fd`、`O_NOFOLLOW` 等 POSIX 文件安全能力。这台 Windows 未完成其全链路验证；没有通过删除断言或放宽文件安全实现使其伪通过。测试的工具列表断言更新为现有公开工具的精确集合。发布 Linux Web 镜像前仍应在该镜像执行此测试。

这里记录的是本次全仓清单检查及已确认项的清理结果，不是对所有动态执行路径永远无孤儿代码的证明。未来下线功能应按 `AGENTS.md` 同步检查入口、专用资源和测试，而不是继续积累旧副本。

## 后续检查：非 Web 模块与实际产品入口

日期：2026-11-06。后续检查基线：`18bad65b3501de11da6f61bdc2a4c8e1ee3a02d7`。以下为该基线之后的增量，不计入上面的 16 个文件和语言包数量。

这次还检查了入口是否真正启用、事件是否仍有生产者、引用是否仅来自旧测试。发现仅靠“源码中还有引用”会漏掉已下线功能：Cardling 的 App 状态始终发送 `enabled: false`，场景消费者也已没有注册工具生产事件。旧 Markdown 独立应用只剩测试在装配，实际产品已使用 Canvas。

| 确认的残留 | 处理与保留边界 |
| --- | --- |
| Cardling 桌面窗口 | 删除 `CardlingWindow.tsx`、Electron 窗口/拖动/位置逻辑、IPC、preload API/监听器、类型、设置读写及 renderer 路由 |
| Cardling 场景链路 | 删除 `features/cardling`、无生产者的 scene 回调及聊天扫描/覆盖层；同步删除专用样式和失效说明文档 |
| 旧 Markdown 独立应用 | 删除 `MdPresentationApp` 外壳、`BushItSidebar` 和 `CreationFileTree`。仍在当前画布使用的文档编辑组件迁到 `BushItDocumentPage.tsx`，保留草稿、自动保存、冲突处理、实时编辑和 Team 文档保存 |
| 无调用的转导出 | 删除 `src/i18n/catalog.ts`、`src/features/voice/realtimeAgentError.ts`；平台语言包和 Runtime 的真实错误处理实现继续保留 |
| 旧文件中夹带的共享样式 | 聊天气泡规则迁到 `message-bubbles.css`，减少动画规则迁到 `reduced-motion.css`，Canvas 侧栏规则迁到 `canvasSidebar.css`，检查器规则归回 `inspector.css`；不能随旧功能整文件丢弃 |

中英文语言包各移除 159 个旧键，其中 7 个仍在使用的通用标签改为 `common.*`；另新增 15 个 Runtime/MCP 文案键。没有删除用户原有配置文件、文档或历史记录。

再次核实并保留的入口包括 Team 工作流、实时语音桥、Office Workers、Agent/Worker/Bot Gateway CLI、Web Tenant Broker，以及由 Vite 插件注入的 Office 适配模块。`companionTools` 是 Skill 配套工具元数据，不属于 Cardling。`useCreationLiveEdit` 和 `TeamDocumentEditor` 由迁移后的当前文档组件调用，也不是孤儿模块。

非 Web 解耦同时完成：26 份系统提示词和行为策略迁到 `assets/prompts`；MCP App 文档、桥脚本与画布样式迁到 `assets/templates`。提示词使用纯文本插值，界面模板使用转义文本、安全 JSON 和显式 HTML 边界；资源随平台包发布。Assistant 的应用自有状态保留消息键，读取时按语言解析；CLI 保持英文。

回归使用临时配置和测试文件。旧独立应用外壳的专属导航测试随入口删除；仍有效的富文本、引用链接、输入法、菜单和流式编辑/人工接管检查迁到当前 Canvas。预加载和构建边界测试明确验证 Cardling 不再暴露。覆盖提示词原文摘要与变量契约、Assistant/子 Agent/协议、当前 Canvas/Team/MCP App、完整 App 视图、语言包、设置、原生菜单、主窗口与 Shadow 启动，以及桌面/Node/Web 类型检查和生产构建。

该结论覆盖已检查的源码和装配入口；不以单次静态扫描声称整个仓库不再存在任何闲置分支。
