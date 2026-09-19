# 浏览器与 Computer Use：CardBush 内置能力边界

浏览器自动化优先连接用户正在使用的真实 Chrome，通过 Browser Connector 和本地桥保持现有扩展、登录状态与个人配置。内置浏览器负责应用内查看和交互，逐步补齐浏览器功能。两者与 Computer Use 都属于 CardBush 核心产品能力，随应用交付和维护；代码模块化是为了分清职责，并非把它们改造成可替换的第三方插件。

## 已落实

- 设置侧栏独立提供「浏览器」和「电脑操控」。Chrome 连接、启停以及 Computer Use 原有配置可直接管理。
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
| Chrome 执行 | `packages/cardbush-chrome-mcp/`、`electron/chromeConnector*`、随应用提供的 Chrome 扩展 | 工具协议、本地桥、会话标签组、站点授权、截图及下载 |
| 核心身份保护 | `electron/coreCapabilities.ts`、`productPlugins.ts` | 防止外部目录覆盖核心能力 |

插件页面只复用核心设置组件和展示目录信息，核心组件没有反向导入插件管理页面或其样式。配置仍兼容现有 `apps.json` 中的 Chrome / Computer Use 条目，避免迁移时丢失用户设置；工具服务总开关暂时仍沿用现有逻辑，关闭时独立设置页会说明原因。

运行时继续由 CardBush 注册固定的 `chrome_devtools` 和 `cardbush_apps` 服务。MCP 是进程通信和工具描述接口，不意味着普通插件能接管核心实现或权限。随应用的 `assets/plugins/` 目录保留现有资源打包方式。

## 截图中各项能力的范围

| 能力 | 当前实现 / 推荐路径 | 后续工作 |
| --- | --- | --- |
| 默认初始页 | 本次已完成；内置新标签与真实 Chrome Connector 共用宿主配置 | 可在此协议上继续扩展启动策略 |
| Chrome 扩展 | 连接真实 Chrome，继续使用 Chrome 中已有扩展；在 Chrome 扩展管理器安装、配置、移除 | 可增加从 CardBush 打开 Chrome 原生管理页的快捷入口 |
| 密码、联系信息、自动填充 | 使用真实 Chrome 自己的密码管理和自动填充 | CardBush 自建密码库、明文读取或跨浏览器导入不在本次实现范围 |
| 网页 / 本地 URL 的默认打开位置 | 保留当前内置预览和显式工具路由 | 增加统一的外部链接路由偏好，分别处理网页与本地开发地址 |
| 完整网址显示 | 当前地址栏已有网址与导航 | 增加简洁 / 完整显示偏好 |
| 浏览历史 / 清理数据 | Chrome 原生管理器可用；CardBush 已有数据维护能力 | 内置浏览器需独立历史索引、分区清理入口，以及智能体访问历史的授权策略 |
| 下载目录 / 保存询问 / 下载记录 | Chrome 原生配置可用；Connector 已有任务归属、去重、状态、取消与完成后产物回传 | 补齐 CardBush 统一下载管理页和持久化偏好；不能把网页下载临时文件当完成产物 |
| 网站摄像头 / 麦克风权限 | 真实 Chrome 由浏览器原生站点设置管理 | 内置浏览器需按来源实现权限存储及 Electron 权限处理器 |
| 智能体站点权限 | Connector 已有本次 / 网站 / 全部网站授权和会话标签组隔离 | 可增加浏览、上传、下载的分别授权与可视化例外规则；现有授权不能直接等同于截图中的三列表格 |
| 批注截图 | 已有截图和图像产物回传链路 | 增加是否携带批注的偏好及渲染规则 |
| 站点工具 / WebMCP | 不声明已支持 | 需要单独的发现、来源验证和调用权限边界 |
| 完整 CDP | 保留需要用户主动配置的远程调试兼容路径 | 完整 CDP 与普通站点访问是不同授权，不能由新开页或安装插件自动开启 |

Electron 的扩展支持是 Chrome 扩展 API 的子集，不能承诺任意 Chrome Web Store 扩展都在内置浏览器中运行。这也是优先真实 Chrome 的原因：[Electron 官方说明](https://www.electronjs.org/docs/latest/api/extensions)。内置站点权限、存储清理与下载入口可以利用 Electron 的会话接口逐项实现：[Session API](https://www.electronjs.org/docs/latest/api/session)。

## 验证

`npm run test:browser-settings` 覆盖配置持久化、URL 校验、并发保存、工具实时读取主页、真实 Electron 主进程 / preload / Webview 新标签链路，以及独立设置页面与插件身份保护。

UI 测试使用隔离的 Electron 资料目录和本地网页，不启动或修改用户真实 Chrome。正常扩展兼容性由真实 Chrome 提供，本次没有逐个测试用户安装的第三方扩展。
