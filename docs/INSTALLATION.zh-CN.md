# 安装与更新

[English](INSTALLATION.md) · [简体中文](INSTALLATION.zh-CN.md)

## 选择入口

| 入口 | 安装内容 | 运行位置 |
| --- | --- | --- |
| Microsoft Store MSIX | 桌面应用及随包 Runtime | Windows，以商店当前包的要求为准。 |
| GitHub 桌面产物 | 发行页附带的安装程序或 AppImage | 该产物声明的系统与架构。 |
| `npm install -g cardbush` | Agent 服务、终端 CLI 和运行资源 | Windows 或 Linux 上的 Node.js 24，不需要 Electron。 |
| 源码工作区 | 开发工具与本机构建产物 | 在目标系统上构建，见[参与开发](../CONTRIBUTING.zh-CN.md)。 |

下载入口为 [Microsoft Store](https://apps.microsoft.com/detail/9N7XNDD5WRGS)、[npm](https://www.npmjs.com/package/cardbush) 和 [GitHub Releases](https://github.com/pycode4micro/cardbush/releases)，三个渠道独立发布。截至 2026 年 10 月 28 日，npm 为 1.0.13，GitHub 的公开桌面产物仍是较旧的 1.0.0-beta.3 预发布版。源码版本号、发行说明或 Actions 构建成功均不等于安装包已经上架。

当前桌面源码支持 Windows 10 1809+ / Windows 11 x64 和 Linux x64，Linux CI 使用 Ubuntu 22.04。未发布 macOS、ARM64 或 32 位桌面包。Windows 10 使用普通窗口背景，支持条件满足的 Windows 11 可使用 Mica。详见 [Windows 兼容性](WINDOWS_COMPATIBILITY.zh-CN.md)。

## Windows 桌面

安装商店包后从开始菜单启动 CardBush，MSIX 更新由 Windows 管理。正常卸载 MSIX 会删除包所属数据，请先备份需要保留的内容。

使用 GitHub EXE 时核对发行版本、架构与附带的 SHA-256 校验值。开发安装包或 CI 产物不同于正式签名发行版。终端工具需要可用的受支持 Shell；相应操作需要 PowerShell 7 和 Git for Windows。插件所需账号及可选依赖仍须单独配置。

## Linux 桌面

下载匹配的 x86-64 AppImage，按需重命名后运行：

```sh
chmod +x CardBush.AppImage
./CardBush.AppImage
```

AppImage 需要 FUSE 2，Ubuntu 22.04 提供 `libfuse2`。无法使用 FUSE 时：

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./CardBush.AppImage
```

Chromium 沙箱需要保持可用，不要把 `--no-sandbox` 当作通用安装修复。Windows 外部浏览器连接器和 Windows Computer Use 插件不属于 Linux 桌面能力，内置标签页仍可使用。可选远端 Linux 桌面使用另一套集成。

## npm Agent 与 CLI

```sh
node --version
npm --version
npm install -g cardbush@latest
cardbush --version
cardbush --help
```

使用 Node.js 24 和 npm 10 或更高版本。该包注册 `cardbush` 与 `cardbush-agent`，无需单独安装私有工作区包或 Electron，第三方依赖按目标平台安装。

进入工作目录后运行 `cardbush`，新会话使用该目录。Windows 使用 Windows 路径，例如 `Set-Location C:\Work\project`。没有模型时，按 CLI 提示编辑配置文件。`/settings` 展示配置位置，`/model` 选择模型。本机 API Key 模型可独立运行，受支持的账号模型使用应用的本机授权桥。详见 [CLI](CLI.zh-CN.md)、[模型接入](MODEL_CONNECTIONS.md)和 [SIWC](SIWC_INTEGRATION.zh-CN.md)。

### 命令找不到或版本过旧

Windows 使用 `Get-Command cardbush -All` 和 `where.exe cardbush`，Linux 使用 `command -v cardbush` 和 `type -a cardbush`，与 `npm prefix -g`、`npm ls -g cardbush --depth=0` 的结果对照。将 npm 的全局命令目录加入用户 PATH，然后重新打开终端。Windows 通常就是全局 prefix，Linux 通常是其 `bin` 子目录，以本机实际结果为准。

`npm link` 安装会指向源码目录，使用该目录的构建产物，不会在 Git 更新后自动重新构建。可运行 `npm run build:agent`，或用 registry 安装替换链接。应同时核对实际命令路径和安装来源，不能只看 `--version`。

## 更新与卸载

```sh
npm install -g cardbush@latest
cardbush --version
```

新启动的 CLI 使用新代码。服务更新应先等待已接收任务完成，停止对应服务，更新包，再使用原数据目录和原参数重启。npm 更新不会同时更新商店应用、Docker 镜像或其他机器上的安装。

```sh
npm uninstall -g cardbush
```

不带 `-g` 的 `npm uninstall cardbush` 只影响当前 npm 项目，不会删除全局命令。卸载 npm 程序文件不会自动删除独立 Agent 或 CLI 数据目录；请单独备份和管理，不要删除其他运行中服务的数据。

## 首次配置与排错

在应用中打开设置 → 模型管理。API Key 模型需要选择服务商及匹配的 Responses、Chat Completions 或 Anthropic Messages 协议；受支持的账号按流程完成本机授权。每个会话保留自己的模型选择，配置中的默认值用于新会话。

模型错误记录协议、模型与不含凭据的错误信息；CLI 问题使用 `/logs` 和 `--version`；Browser Use 使用 `/browser status` 及扩展的“连接”操作，见[浏览器配置](CORE_BROWSER_COMPUTER_USE.md)。Runtime 启动失败应检查实际执行主机的日志与资源，不要反复重装无关客户端。

另见[安全与数据处理](../SECURITY.zh-CN.md)、[npm 打包](NPM_AGENT.md)、[Agent 服务](AGENT_SERVICES.md)及 [Docker 部署](../deploy/agent/README.md)。
