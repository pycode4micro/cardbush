# 浏览器与 Computer Use：CardBush 内置能力边界

Browser Use 在 Windows 11 上连接用户正在使用的 Chrome 和 Microsoft Edge，通过分别配对的本机连接保持各自的扩展、登录状态与个人配置。内置浏览器负责应用内查看和交互。两者与 Computer Use 都属于 CardBush 核心产品能力，随应用交付和维护。

## 内置网页翻译

内置浏览器地址栏的收藏旁提供翻译按钮，普通标签与分屏共用。目标语言使用当前应用语言；语言设置为“跟随系统”时沿用解析后的系统语言。点击后使用本机配置的默认模型，将当前页面文字分批翻译并原位替换；再次点击恢复原文，翻译中点击则取消。该功能会向所配置的模型服务发送待译文字，不需要另配翻译服务。

翻译复用 Runtime 的模型协议适配器（Responses / Chat Completions / Anthropic Messages），不创建会话、工具执行或个性化记忆。主进程仅接受应用自身拥有的 HTTP(S) guest，使用独立脚本上下文提取和替换文本节点，不替换 HTML、不执行模型输出。表单值、可编辑区、隐藏内容、代码与声明不翻译的节点跳过；保留链接、事件与原文，新页面、关闭标签或取消时中断请求，失败恢复已译部分。

一次翻译处理当前已加载文档，最多 800 个文字节点／80,000 字符；重复文字合并，按最多 80 条／6,000 字符调用模型。超出容量或页面在翻译中更新时显示部分翻译状态。图片文字、iframe、代码、后续动态加载内容不纳入本次翻译。原文仅保存在对应网页的内存中，恢复或导航时释放，不写入会话历史。

实现位于 `electron/browserTranslation*.ts/mts`、`src/features/inspector/useBrowserTranslation.ts` 与 `BrowserTranslateButton.tsx`。验证：`npm run test:browser-translation`，使用临时网页与模拟模型响应，不发送用户网页内容。

## Browser Use 连接与路由

- 对外名称统一为 **Browser Use**，模型工具命名空间为 `browser_use`。现有资源目录、内部配置身份 `chrome` 和私有 IPC 标识保留，避免重置已有启停选择；这些标识不代表仅支持 Chrome。
- 仅支持 Windows 11；Chrome、Edge 使用同一份 MV3 扩展（1.2.1），分别在 `chrome://extensions` / `edge://extensions` 加载并配对。升级时重新加载原扩展，避免卸载导致已保存的扩展数据被清除。
- 设置中选择浏览器、填写可选连接名称，再生成五分钟有效的配对码。每条配对具有独立凭据；Chrome、Edge 及不同浏览器用户配置可同时在线，最多保留八条。更换同一配置的配对后可移除旧记录。
- 扩展通过固定扩展 Origin 和双向 HMAC 验证本机 WebSocket；握手确认浏览器类型。凭据不出现在模型工具、连接状态或诊断中。仍只监听 `127.0.0.1`，不引入外部注册表项或新的 MSIX capability。
- `list_browsers` 返回连接名称、浏览器类型、在线状态、默认连接和当前会话选择；`select_browser` 显式绑定目标连接。未选择时，首次页面调用使用默认连接。绑定保存在受保护的 `browser-connector/routes.json`，重启不改变归属。
- 更改默认值只影响未绑定会话。断线、撤销配对或重启不自动回退到另一浏览器；在途请求立即返回断线错误，动作可能已经执行，需要恢复后重新观察。连接之间按请求和会话校验响应，不按相同 tabId 路由。
- 显式切换先释放旧浏览器的本会话控制；释放失败则不切换。在途操作期间不允许切换。成功后模型必须重新获取页面和元素 ID。
- 移除连接只撤销对应凭据；已绑定会话保留原归属，需明确选择新连接。关闭连接器停监听及控制但保留配对和路由，再次开启后自动重连；“移除连接器配置”才撤销全部配对并清理路由。普通退出保留配对、绑定和启用意图。
- 扩展使用 local 保存启用意图及站点/全部网站授权。重启浏览器也自动重连，暂时离线以 30 秒、1 分钟、最多 2 分钟的间隔继续重试，打开弹窗可立即重试；明确关闭扩展连接后保持关闭。配对码五分钟只约束首次配对，成功后的凭据持续有效。临时授权和标签组标识仍只存 session，不在浏览器重启后凭名称认领个人标签。
- 默认加载 Browser Use 自有 skill。原厂 Chrome DevTools MCP 和资源保留为用户主动选择的高级远程调试模式，此路径仍仅面向 Chrome，不作为连接器失败时的自动回退。
- 许可按来源区分：CardBush 自有连接器、适配层与技能遵循仓库 Apache-2.0；高级模式的 Google MCP 及其依赖保留上游许可。分发说明与 axe-core 对应源码入口见 `assets/plugins/chrome/THIRD_PARTY_NOTICES.md`。
- 本次不增加 Linux/macOS 支持，也不改变 Windows Computer Use 的实现。

## 已落实

- 插件目录中 Browser Use 和 Computer Use 的卡片描述、详情及示例提示词跟随界面语言即时切换。清单默认文案为英文，`cardbush.localizations.zh` 提供中文；宿主解析后由显示层按语言取值，缺项回退默认文案，不改写插件配置。其他插件也可选填 `cardbush.localizations.zh/en` 的 `shortDescription`、`longDescription`、`defaultPrompt`。
- 设置侧栏独立提供「浏览器」和「电脑操控」。Browser Use 连接、启停以及 Computer Use 原有配置可直接管理。
- 初始主页默认 `https://www.google.com/`，在「浏览器 → 初始页面」修改。支持 HTTP(S)、省略协议的普通域名，以及显式 `about:blank`。
- 主页存于宿主的 `product-host/config/browser.json`，跨会话、重启保留。新建内置标签页，以及 Connector 的 `new_page` 未提供 URL 时，每次读取最新配置。传入 URL 的工具调用保持原目标。
- 同一主页可以新建多个独立标签页；标签身份不再写入网址查询参数。保存主页不会跳转已经打开的页面，也不会改写用户自己的 Chrome 启动设置。
- 内置网页以 100% 比例显示，取消按面板宽度自动缩小字体；较宽页面使用网页自身的横向滚动。拖动面板仍合并尺寸更新，避免每一帧触发文档重排。
- 加载提示只跟随顶层文档导航。滚动触发的 iframe 延迟加载、页面内跳转不再遮住正文；已经显示的网页在后续导航等待期间保持可见。超时后收到成功的文档就绪事件会自行清除超时提示，无需再刷新一次。
- 主页修改使用版本号和原子写入，旧窗口不能覆盖更新的配置。加载或保存出错有明确反馈，并可重新加载。
- `chrome`、`computer-use` 及大小写、下划线别名保留给核心能力。安装器拒绝外部同名包；目录扫描忽略旧的同名用户包，保留随应用发布的实现。普通插件安装和管理不受影响。

## 代码职责

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 配置协议 | `packages/bush-protocol/src/browser.ts` | 默认主页、URL 验证、配置版本 |
| 宿主存储 | `packages/cardbush-product-host/src/browserConfigStore.ts` | 持久化、串行写入、版本冲突检查 |
| 桌面接入 | `electron/browserSettings.ts`、`main.ts`、`preload.ts` | 确定配置位置；仅主界面可读写主页；传递工具进程的配置路径 |
| 浏览器设置与新标签 | `src/features/browser/` | 独立设置组件、连接状态、主页读取、浏览器自身样式 |
| 桌面操控设置 | `src/features/computerUse/` | 截图目录、让行、恢复指针、启动应用与关闭窗口开关 |
| 旧配置适配 | `src/features/capabilities/CoreCapabilitySettings.tsx` | 复用现有配置版本与运行时同步机制，不依赖插件管理页面 |
| Browser Use 执行 | `packages/cardbush-chrome-mcp/`、`electron/chromeConnector*`、随应用提供的 Browser Use 扩展 | 工具协议、本地桥、会话标签组、站点授权、截图及下载 |
| 核心身份保护 | `electron/coreCapabilities.ts`、`productPlugins.ts` | 防止外部目录覆盖核心能力 |

插件页面只复用核心设置组件和展示目录信息，核心组件没有反向导入插件管理页面或其样式。配置仍兼容现有 `apps.json` 中的 Chrome / Computer Use 条目，避免迁移时丢失用户设置；工具服务总开关暂时仍沿用现有逻辑，关闭时独立设置页会说明原因。

运行时继续由 CardBush 注册固定的 `browser_use` 和 `cardbush_apps` 服务。MCP 是进程通信和工具描述接口，不意味着普通插件能接管核心实现或权限。随应用的 `assets/plugins/` 目录保留现有资源打包方式。

## 截图中各项能力的范围

| 能力 | 当前实现 / 推荐路径 | 后续工作 |
| --- | --- | --- |
| 默认初始页 | 本次已完成；内置新标签与Browser Use 共用宿主配置 | 可在此协议上继续扩展启动策略 |
| 浏览器扩展 | 连接 Chrome / Edge，使用各自已有扩展；在对应浏览器管理器中安装、配置、移除 | 可增加从 CardBush 打开浏览器管理页的快捷入口 |
| 密码、联系信息、自动填充 | 使用所选浏览器自己的密码管理和自动填充 | CardBush 自建密码库、明文读取或跨浏览器导入不在本次实现范围 |
| 网页 / 本地 URL 的默认打开位置 | 保留当前内置预览和显式工具路由 | 增加统一的外部链接路由偏好，分别处理网页与本地开发地址 |
| 完整网址显示 | 当前地址栏已有网址与导航 | 增加简洁 / 完整显示偏好 |
| 浏览历史 / 清理数据 | Chrome / Edge 原生管理器可用；CardBush 已有数据维护能力 | 内置浏览器需独立历史索引、分区清理入口，以及智能体访问历史的授权策略 |
| 下载目录 / 保存询问 / 下载记录 | Chrome / Edge 原生配置可用；Connector 已有任务归属、去重、状态、取消与完成后产物回传 | 补齐 CardBush 统一下载管理页和持久化偏好；不能把网页下载临时文件当完成产物 |
| 网站摄像头 / 麦克风权限 | Chrome / Edge 由浏览器原生站点设置管理 | 内置浏览器需按来源实现权限存储及 Electron 权限处理器 |
| 智能体站点权限 | Connector 已有本次 / 网站 / 全部网站授权和会话标签组隔离 | 可增加浏览、上传、下载的分别授权与可视化例外规则；现有授权不能直接等同于截图中的三列表格 |
| 批注截图 | 已有截图和图像产物回传链路 | 增加是否携带批注的偏好及渲染规则 |
| 站点工具 / WebMCP | 不声明已支持 | 需要单独的发现、来源验证和调用权限边界 |
| 完整 CDP | 保留需要用户主动配置的远程调试兼容路径 | 完整 CDP 与普通站点访问是不同授权，不能由新开页或安装插件自动开启 |

Electron 的扩展支持是 Chrome 扩展 API 的子集，不能承诺任意 Chrome Web Store 扩展都在内置浏览器中运行。这也是连接外部浏览器的原因：[Electron 官方说明](https://www.electronjs.org/docs/latest/api/extensions)。内置站点权限、存储清理与下载入口可以利用 Electron 的会话接口逐项实现：[Session API](https://www.electronjs.org/docs/latest/api/session)。

## 验证

`npm run test:chrome-connector` 覆盖连接配对、身份校验、生命周期、独立路由与断线失败；`node scripts/test-plugin-connections-ui.mjs --core-settings` 覆盖设置页的 Chrome/Edge 配对、默认选择、单连接移除及主题/窄屏布局。

`node scripts/test-browser-use-native.mjs` 用 Windows 上真实安装的 Chrome/Edge，在临时、无界面的独立配置中加载真实扩展，通过生产 Broker 和 MCP 工具验证创建页面、读取可访问结构、填写、点击、截图、切换和释放控制。2026-09-29 在 Chrome 153.0.8010.53 / Edge 154.0.4258.37 通过；结果写入 `tmp/browser-use-native-result.json`。该测试不操作用户常用浏览器配置，不代替商店分发或 MSIX 安装认证。

UI 测试使用隔离的 Electron 资料目录和本地网页，不启动或修改用户真实 Chrome。正常扩展兼容性由真实 Chrome 提供，本次没有逐个测试用户安装的第三方扩展。
