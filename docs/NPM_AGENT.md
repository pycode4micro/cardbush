# CardBush Agent + CLI

CardBush 的 npm 包同时提供独立 Agent 服务与终端对话客户端，不需要安装桌面 App。需要 Node.js 24；Windows 与 Linux 使用同一份发布包。

## 安装与使用

发布到 npm 后可执行：

```sh
npm install --global cardbush
cardbush --version
cardbush --help
```

进入工作目录后运行 `cardbush`，即可使用本机 Agent。首次未配置模型时，CLI 会显示配置文件路径和示例；配置 API-key 模型后可独立运行。ChatGPT 账号模型继续遵守现有本机 App 授权桥要求。

```sh
cd /path/to/workspace
cardbush
cardbush --resume
```

部署独立服务时，CLI 与服务从同一包安装：

```sh
cardbush serve --data-dir /srv/cardbush/agent-a --name Agent-A
# 等价命令
cardbush-agent --data-dir /srv/cardbush/agent-a --name Agent-A
```

Windows 使用 Windows 绝对路径。服务不会因客户端退出而关闭；使用独立数据目录，并通过已有服务管理器托管。数据与安装目录分开，更新程序不替换会话、插件配置或令牌。

在服务器终端连接已经运行的服务：

```sh
cardbush --url http://127.0.0.1:4780 --token-file /srv/cardbush/agent-a/access-token
```

首次连接后保存服务地址与令牌文件位置，之后可直接运行 `cardbush`。`--local` 明确切回当前系统用户的本机 Runtime。连接其他机器时使用 HTTPS 或已有 SSH 隧道；保留原有身份、令牌及权限检查。

## 发布前的本地包

源码仓库仍为 private，不能直接发布仓库根目录。维护者运行 `npm run package:npm` 构建独立发布目录和 `.tgz`，命令打印产物路径及摘要，不自动发布。然后运行隔离安装验证：

```sh
npm run verify:npm-package -- --tarball /absolute/path/cardbush-1.0.12.tgz
```

验证在仓库外创建临时安装目录，检查两个命令、原生资源、服务鉴权，并使用本地模拟模型分别完成服务与独立 CLI 对话；不覆盖用户全局安装、不读取用户配置、不发起付费模型调用。成功后将 `verification-report.json` 写到 tarball 旁边。确认发布名称和版本后，可将已验证的 tarball 提交 npm；无需分别发布内部工作区。

也可以用该 tarball 安装到目标机器：

```sh
npm install --global /absolute/path/cardbush-1.0.12.tgz
cardbush --version
cardbush serve --help
```

npm 包包含所需内部工作区模块和运行资源，第三方依赖由 npm 安装到目标平台；不要求分别发布私有 `@cardbush/*` 包，不下载 Electron，也不携带桌面安装包。构建时必须提供完整 Windows 原生进程保护组件，避免发布一个在 Windows 无法执行工具的包。

## 更新

服务与 CLI 使用同一发布版本。部署新版本前按现有维护流程等待任务空闲，更新包并重启对应服务；新打开的 CLI 使用新版本。已有终端不会被强制中断。保留旧 tarball 或版本目录以便回滚。

普通服务不要求图形桌面；Browser Use、Computer Use、Office 渲染等可选能力仍取决于目标主机的平台和依赖。需要独立 Linux 桌面时使用项目提供的 Docker desktop profile。
