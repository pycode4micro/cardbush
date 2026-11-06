# 应用语言包与外观状态

[English](README.md) · [简体中文](README.zh-CN.md)

应用自有文案来自 `locales/*.json`，包括导航、设置、对话、输入框/队列、审批、工具状态、语音、图片、Office/3D 预览外壳和原生菜单。Renderer 与 Electron 共用 `@cardbush/platform/i18n`，React 通过 `src/i18n` 引用。

用户内容、路径、协议标识、文件类型缩写、产品名和第三方工具原始回执是数据，不属于 UI 翻译。插件/服务器字典使用 `localizedContent`；模型指令、文档正文不是 UI 文案。自有错误信息要翻译，机器错误码保留。

## 添加语言

1. 复制 en.json 为新 JSON，设置 BCP 47 `locale`（如 fr）及本族语 `name`，翻译 messages 并保留键和占位变量。
2. 运行 `npm run test:ui-localization`。平台构建自动发现并校验 JSON，生成共享目录与类型键，不修改组件导入、语言分支或选择器。生成的 TypeScript 不提交 Git。
3. 正常构建/启动，设置选择器从元数据生成。系统与保存的 locale 使用统一解析，例如 fr-CA 可回退 fr，不支持的语言回退英文。

构建器/运行时允许缺项回退英文，但随包交付的语言必须完整，回归按英文键核对。新文案补齐所有随包语言。新语言需重新构建，不从任意运行时路径加载。

## 使用文案

```tsx
const t = uiText(language);
return <button aria-label={t('image.preview', { name })}>{t('common.close')}</button>;
```

整句话使用命名变量，不拼接翻译片段。正文、占位、提示和无障碍标签都用消息键，禁止组件中的语言条件分支或双语对象。

复数必须含 other，可提供 zero/one/two/few/many；count 是有限数，由所选消息语言的 Intl.PluralRules 决定形式。各形式保留必需变量。列表用 formatMessageList，日期/数字用所选语言的 Intl。

插值是非递归纯文本，`{{`/`}}` 表示字面花括号。缺变量或未知键直接报错，不生成空白 UI。React 自动转义；HTML 预览需用 htmlText 等先转义。

组件/辅助函数和 Hook 依赖传递当前语言，无语言参数的组件使用 UiLanguageProvider 下的 useUiLanguage。uiText() 在调用时读 document 语言，无 document 默认英文，适合动作发生时解析错误，不应生成模块级翻译常量。主窗口专属 app:set-ui-language 更新原生弹窗/托盘，启动前回退 OS locale。文件/应用动作也可显式携带语言。可复用标签表保存键、渲染时解析，确保已挂载控件响应切换。

## Web 与文档模板

Web 入口通过 `web/Language.tsx` 复用同一套语言包，选择器来自 `uiLanguages`，切换后更新已挂载组件和 document 语言。只保存语言标识，不保存翻译结果。非 React 的共享辅助函数引用 `@cardbush/platform/i18n`，在调用时解析文案。

React 表单布局放在独立模板组件，通过类型化的数据和回调注入。例如 `web/ModelAdmin.tsx` 负责请求与状态，`web/templates/ModelAdmin.template.tsx` 负责布局，`model-form.json` 保存可复用选项、默认值和消息键。不要用运行时 HTML 或 JSX 求值取代 React。

原生静态 HTML 外壳和交互脚本放在 `assets/templates/*.html`、`*.js.template`，平台构建将其编入 ESM 和 CommonJS 产物。发行程序不读取源码目录，不依赖当前工作目录；不要手改生成模块。使用 `@cardbush/platform/templates` 的 `renderHtmlTemplate`：`{{text:name}}` 转义普通值，`{{json:name}}` 生成安全的 JavaScript 字面量并转义脚本闭合字符，`{{html:name}}` 仅接收第三个参数显式提供的可信渲染片段。缺少变量、多余变量都会报错，替换不递归执行。预览、画布导出和 OAuth 页显式传递当前语言；翻译与用户数据即使包含标签也仍按文本处理。

## 运行时状态与模型策略

Assistant 读取请求携带当前界面语言；应用自有错误保留消息键和变量，在每次读取时解析，使已出现的错误也能随语言切换。外部服务错误保持原文。子 Agent 的默认名称使用统一语言解析器，显式或已保存的名称不改写。CLI 保持英文，不要求增加语言选择器。

MCP App 的页面壳、样式及桥接脚本也使用 `assets/templates`（`.html`、`.js.template`、`.css.template`），注入翻译后的宿主消息与安全序列化的组件数据。继续保留 iframe 沙箱、宿主消息校验和 CSP；平台提供的 HTML 仍属于沙箱内的不可信内容。下线功能应连同专用资源一起删除，不应再迁入新模板。

模型策略单独放在 `assets/prompts/*.md`，通过 `@cardbush/platform/prompts` 的 `renderPromptTemplate` 使用。`{{value:name}}` 只插入纯文本，不递归解释；不要把策略混入 UI 语言包，抽离时不能改变消息角色和拼接顺序。构建器统一换行并去掉资源末尾的一个换行，其余首尾空白仍有意义。资源随 ESM/CommonJS 发行，无需运行时读取文件系统。有意修改策略时同步更新策略摘要夹具，并保留语义策略测试。

## 外观归属

视觉变体由 CSS 定义，状态使用语义 class/data-*，尺寸、配色、间距和图标使用 CSS 变量。禁止在 JSX 三元表达式中选择硬编码颜色、字号、显示或变换。

主题在 src/styles/theme.css 和共享配置；队列尺寸在 runtime-rail.css 的 queue 变量，相册尺寸与加载状态在 message-image-gallery.css。紧凑图标用 CSS 尺寸变量，不使用条件 size 数字。行为、测量坐标、动态画布和导入文档几何仍可由 TypeScript 处理；条件 class 合理，视觉效果留给 CSS。

## 验证

- `npm run test:ui-localization`：键、变量、复数、回退、异常输入、隔离第三语言发现、ESM/CommonJS 目录及 App/Web/原生源码约束。
- `npm run test:web-admin-ui`：隔离模拟服务下的真实 Web 表单、即时切换语言、草稿保留、提交/重试、窄窗口和文本转义。
- `npm run test:html-templates`：发行模板、变量约束、转义及预览/OAuth 多语言输出。
- `npm run test:nonweb-templates`：策略原文一致性、ESM/CommonJS 打包及 MCP 输入转义。`node scripts/test-mcp-apps-ui.mjs` 验证真实沙箱通信。
- `npm run test:app-views`：对话、欢迎/首次发送、队列图片、流式、侧栏和预览。
- `node scripts/test-window-menu.mjs`、`node scripts/run-settings-context-ui-test.mjs`：原生菜单、语言切换和响应式设置。
- `npm run build`、`npx tsc --noEmit -p tsconfig.json`：生产构建和类型检查。

测试使用隔离临时语言包/配置，不修改用户语言或连接。
