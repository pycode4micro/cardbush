# CardBush Agent + CLI npm 包

[English](NPM_AGENT.en.md) · [简体中文](NPM_AGENT.md)

官方 [cardbush npm 包](https://www.npmjs.com/package/cardbush)同时提供独立 Agent 服务与终端客户端。Windows 和 Linux 使用同一份发布包，需要 Node.js 24、npm 10 或更高版本。API Key 模型不需要桌面 App。

本页与当前源码同步。已发布的 **1.0.13** 不包含新的 `cardbush worker` 注册与远程聊天入口迁移；使用下述 worker 功能时，需要在两端重新构建当前源码。发布范围见 [1.0.13 说明](https://github.com/pycode4micro/cardbush/blob/main/docs/releases/1.0.13.zh-CN.md)。

无需用户提前准备部署压缩包：已有匹配发行版时，目标机直接安装固定版本；测试未发布代码时，Agent 可从可访问的完整源码现场构建独立目录或临时 tarball。已有验证过的 `cardbush-VERSION.tgz` 也可直接安装：`npm install --global /absolute/path/cardbush-VERSION.tgz`，无需先发布 npm。选择 tarball 时传输前后核对 SHA-256，并检查实际命令版本与服务能力；不能用 `@latest` 代替未发布候选包。

## 安装与开始使用

```sh
npm install -g cardbush@latest
cardbush --version
cardbush --help
cd /path/to/workspace
cardbush
```

本机模式不需要访问令牌。没有模型时按 CLI 展示的路径与示例编辑配置文件，保存后按 Enter。`/settings` 展示配置位置，`/model` 选择模型与思考强度。ChatGPT 账号模型复用本机 App 授权桥，需保持 App 登录并运行；API Key 模型可独立执行。

`cardbush --resume` 打开会话选择器，`cardbush --resume ID` 恢复指定会话，`/session` 在终端中切换。执行中 Enter 排队，Ctrl+Enter 或 `/steer 文本` 立即指导当前任务。`/artifact` 查看并打开文件，`/tools` 查看执行详情。完整交互见 [CLI 指南](https://github.com/pycode4micro/cardbush/blob/main/docs/CLI.zh-CN.md)。

## 服务与远端连接

一次安装同时注册 `cardbush` 与 `cardbush-agent`：

```sh
cardbush serve --background
cardbush serve --status
cardbush serve --stop
cardbush serve --data-dir /absolute/path/agent-data --name Agent-A
# 等价的前台服务入口
cardbush-agent --data-dir /absolute/path/agent-data --name Agent-A
```

默认后台服务目录为 `~/.cardbush/service`。Windows 使用 Windows 绝对路径。程序和数据分开；服务不会因普通远端客户端退出而关闭。不同实例使用不同数据目录。

云端部署优先使用普通用户、独立数据目录和回环监听，通过 CardBush 内置 SSH 连接或 HTTPS 接入。`--background` 不注册开机自启。Linux 安装 bubblewrap 后还需验证实际命名空间与沙箱文件操作；低内存主机按职责启用必要插件。版本选择、模型配置、Ubuntu AppArmor 和资源诊断见[内置部署指导](https://github.com/pycode4micro/cardbush/blob/main/assets/skills/cardbush-docs/references/agent-deployment.md)，注册、续接和重启验收见[远程 worker](https://github.com/pycode4micro/cardbush/blob/main/assets/skills/cardbush-docs/references/remote-workers.md#分层验收)。

```sh
cardbush worker add --name Worker --url https://agent.example.com --token-file /private/access-token
cardbush worker list
```

本机聊天不再支持远程直连；旧连接配置不会重定向 CLI。远程连接仅供注册子 Agent，连接后让本地 Agent 保存对应角色。服务保有自己的模型、插件和权限，不自动复制本机配置。CLI 会话默认位于 `~/.cardbush/cli-agent`，独立服务为 `~/.cardbush/service`，两者会话不合并。远程使用 HTTPS 或认证 SSH。详见 [worker 协议](https://github.com/pycode4micro/cardbush/blob/main/docs/SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)。

## 更新与卸载

```sh
npm install -g cardbush@latest
cardbush --version
npm uninstall -g cardbush
```

更新后重新启动 CLI；服务先等待任务空闲，再以原数据目录和参数重启。更新 npm 不会更新桌面 App、其他机器或 Docker 镜像。卸载全局命令必须带 `-g`，且不会自动清除服务数据。若命令来自 `npm link`，源码变化后还需要重新构建；路径排查见[安装指南](https://github.com/pycode4micro/cardbush/blob/main/docs/INSTALLATION.zh-CN.md)。

## 维护者打包与发布

仓库根 `package.json` 标记为 `private: true`，不能直接发布根目录；这不代表 GitHub 仓库是私有的。`npm run package:npm` 构建独立发布目录和 tarball，不自动发布。包包含内部工作区模块与运行资源；第三方依赖由 npm 按目标平台安装，不下载 Electron，也不携带桌面安装包。Windows 原生进程保护组件必须完整。

```sh
npm run package:npm
npm run verify:npm-package -- --tarball /absolute/path/cardbush-VERSION.tgz
npm publish /absolute/path/cardbush-VERSION.tgz --access public --tag latest
```

将示例中的 VERSION 替换为本次实际生成的版本。校验脚本在仓库外的临时目录安装，检查命令、原生组件、服务鉴权和内置 MCP，并通过本地模拟模型完成 worker 注册委派、缓存清理后的子会话历史保留和独立 CLI 对话。不覆盖全局安装、不读取真实用户配置、不发起付费调用，结果写入 `verification-report.json`。该脚本不能替代目标 OS 的安装验证、已授权的云端真实模型/沙箱任务，或 CardBush 内读取 docs 后完成部署的操作流程验收。

仅发布已经验证的那份 tarball。npm 可能要求终端登录及本次发布的两步验证；不要把凭据或验证码写入仓库。收到“正在处理”时等待仓库扫描完成，不重复发布。最终核对 `latest`、版本元数据和匿名下载的完整性，不能只凭 publish 命令退出成功就宣布可安装。

Browser Use、Computer Use、Office 转换等可选能力仍取决于目标平台和依赖。数据与执行边界见[安全说明](https://github.com/pycode4micro/cardbush/blob/main/SECURITY.zh-CN.md)。
