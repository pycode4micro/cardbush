# 参与 CardBush 开发

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

## 准备工作区

使用 Node.js **24** 和 npm **10 或更高版本**。`.nvmrc`、包版本约束、CI 与 Agent 容器均采用 Node 24，原生包在目标系统上构建。

```sh
git clone https://github.com/pycode4micro/cardbush.git
cd cardbush
npm ci
npm run runtime-tools:install
npm run dev
```

Electron 默认从官方源下载，仅在网络需要时配置 `ELECTRON_MIRROR`；下载不完整可运行 `npm run fix:electron`。部分原生或插件专项验证需要额外的平台依赖。详见[依赖维护](docs/DEPENDENCY_SECURITY.md)及 [Windows 兼容性](docs/WINDOWS_COMPATIBILITY.zh-CN.md)。

无界面 Agent 开发使用 `npm ci --ignore-scripts`、`npm run build:agent`，再运行 `node dist-electron/agentServiceCli.mjs --data-dir /absolute/path/agent-data`。它启动 Node 而非 Electron，开发时使用隔离的数据目录。

## 找到对应层级

| 目录 | 职责 |
| --- | --- |
| `packages/bush-runtime` | Agent 循环、工具、权限、任务调度与状态 |
| `packages/bush-product-agent` | 产品指令与回合构造 |
| `packages/cardbush-product-host` | 共用宿主配置及命令约定 |
| `packages/bush-protocol` | 命令、事件与 IPC 类型 |
| `packages/bush-provider-openai` | Responses、Chat Completions 和 Anthropic Messages 适配 |
| `packages/bush-mcp-client` | MCP 传输及资源 |
| `packages/cardbush-platform` | 宿主能力、可执行文件、原生路径与共享本地化 |
| `packages/bush-runtime-electron` | 共用的类型化 Runtime 传输和客户端 |
| `electron` | 桌面生命周期、Node 服务及宿主适配 |
| `src` | React 界面及本地／远端后端适配 |
| `scripts`、`deploy`、`packaging` | 验证、部署与发布工具 |

引入另一套执行循环、配置存储或消息投影前，先阅读[架构指南](docs/ARCHITECTURE.md)，复用已有归属和取消流程。

## 界面与文档修改

[AGENTS.md](AGENTS.md) 和[语言包指南](src/i18n/README.zh-CN.md)规定界面约束。应用自有文字放进 `src/i18n/locales/*.json`，使用消息键与具名插值，并更新所有随包语言。React 使用 `uiText` / `useUiLanguage`，原生和共享代码使用 `@cardbush/platform/i18n`。不要手改生成文件，也不要在业务逻辑中加入语言分支。

视觉变体放在语义 class、data 属性、CSS 变量和主题 token 中。几何测量与画板坐标可以在逻辑层处理，条件硬编码的颜色和尺寸不应混入业务代码。

同一次修改中同步当前指南的中英文版本，保持命令、默认值、能力边界和注意事项一致。保留原文件名与历史报告，避免旧链接失效。新增指南时更新[文档索引](docs/README.zh-CN.md)。法律声明、执行用技能指令及带日期的排查记录不能悄悄改写成当前使用指南。

## 验证修改

```sh
npm run build
npm run typecheck
npm run test:release
```

`test:release` 使用已经构建的产物。无桌面的 Linux 需提供显示环境，例如 `xvfb-run -a npm run test:release`。按修改范围运行专项检查，不能假定发布套件覆盖全部可选集成：

| 修改范围 | 相关验证 |
| --- | --- |
| 界面语言或样式 | `npm run test:ui-localization` 及对应界面回归 |
| 跨应用界面 | `npm run test:app-views`、渲染端类型检查及生产构建 |
| CLI 或部署 | `npm run test:agent-chat`、`npm run test:agent-deployment` |
| MCP 互操作 | `npm run test:mcp-conformance` |
| 助手或语音 | 按需运行 `npm run test:assistant`、`npm run test:voice-realtime`、`npm run test:voice` |
| npm 分发 | `npm run package:npm`，再运行 `npm run verify:npm-package -- --tarball /absolute/path/package.tgz` |
| 纯文档 | 检查链接、锚点、命令、双语内容对应关系及 `git diff --check`。 |

使用隔离配置、模拟模型和可丢弃工作区，不得为了测试修改用户语言偏好、真实会话存储、全局安装或运行中的服务。明确说明证据来自模拟、已安装产物还是真实服务，三者不能相互代替。

## 提交修改

保持修改聚焦，说明用户遇到的问题、修改后的行为、影响边界及相关验证。Bug 提供复现步骤，注明尚未验证的平台或服务商行为。凭据、签名证书、私人原始日志、生成的安装包及 npm tarball 不应进入 Git。

漏洞通过 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 的方式报告；普通反馈进入 [Issues](https://github.com/pycode4micro/cardbush/issues)，代码修改可通过 Pull Request 提交。

## 发布渠道

商店桌面包、签名 EXE / AppImage 和 npm Agent 包是不同产物。详见[跨平台发布](docs/CROSS_PLATFORM_RELEASE.zh-CN.md)、[MSIX](docs/MSIX_STORE_RELEASE.zh-CN.md)和 [npm 打包](docs/NPM_AGENT.md)。构建、上传或修改文档版本号不等于完成发布，应核对公开产物与校验值，并保留第三方许可。
