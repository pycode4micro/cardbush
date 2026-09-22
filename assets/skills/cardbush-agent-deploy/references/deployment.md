# 部署与更新

本文件适用于当前 CardBush 独立 Node 服务。执行前以所部署版本的 `package.json`、CLI `--help` 和实际返回为准，不把桌面安装包当作服务器程序。

## 目录与构建

示例约定：源码目录 `/opt/cardbush/releases/RELEASE_ID`，当前版本链接 `/opt/cardbush/current`，数据目录 `/srv/cardbush/agent-a`，服务账号 `cardbush-agent-a`。将这些值替换为已确定的目标，不原样使用版本占位符。

服务需要 Node.js 22.12+ 和 npm 10+。在目标架构安装依赖，不复制 Windows 的 `node_modules` 到 Linux。构建命令在源码根目录、以普通构建账号执行：

```sh
npm ci --ignore-scripts
npm run build:agent
node dist-electron/agentServiceCli.mjs --help
```

`--ignore-scripts` 避免服务器安装流程下载 Electron；运行服务不需要启动 Electron。保留 `dist-electron`、构建后的工作区包、对应的依赖以及所需资源，不能只上传一个入口 `.mjs` 文件。不要未经验证就删除开发依赖或执行依赖裁剪。

代码目录由部署账号维护；服务账号只需读取代码，并写入自己的数据目录、项目目录和必要缓存。创建独立服务账号及其主目录，数据目录限制为所有者访问；不要对共享目录批量更改所有权。服务账号默认不加入 sudo 或 Docker 管理组。

当前 CLI 的内置资源根目录是 `DATA_DIR/bundled`，不会自动加载源码中的 `assets/skills`。部署时将所需内置 skill 的**完整目录**从 `assets/skills` 安装到 `DATA_DIR/bundled/skills`，包括本部署 skill 的 `references` 和 `agents` 子目录。用户自定义 skill 保存在 `DATA_DIR/skills`；不要覆盖这一目录。更新内置资源时同步对应版本，并保留旧资源以便回滚。不要顺带复制 `assets/plugins` 或任何桌面用户配置。

## HTTP 服务

每个实例第一次启动使用空的独立数据目录；再次启动使用原目录。示例以服务账号运行，避免初次启动产生 root 所有的文件：

```sh
node /opt/cardbush/current/dist-electron/agentServiceCli.mjs \
  --data-dir /srv/cardbush/agent-a \
  --name Agent-A \
  --host 127.0.0.1 \
  --port 4780
```

服务自动生成 `DATA_DIR/access-token`，也支持环境变量 `CARDBUSH_AGENT_TOKEN` 指定至少 32 个字符的令牌。优先使用自动生成的随机令牌，不要将令牌写进启动命令、仓库或聊天。检查目录为 `0700`、令牌文件为 `0600`，且所有者是服务账号；不要通过打印令牌来验证。启动日志仅显示令牌路径。

服务直接提供 HTTP API：`GET /api/agent/v1/info` 获取实例信息，`POST /api/agent/v1/call` 提交 `{operation,input}` 业务操作，`GET /api/agent/v1/events` 订阅事件。事件流按 `Accept` 支持 `text/event-stream`（SSE）或 `application/x-ndjson`（逐行 JSON）。`/health` 和所有 API 均需要 `Authorization: Bearer …`，拒绝带 `Origin` 的请求，包括 `Origin: null`。这是桌面主进程或 SDK 的管理入口，不是网页聊天页面。

## systemd 托管示例

在确认账号、目录、Node 绝对路径后，生成专属于本实例的 `/etc/systemd/system/cardbush-agent-a.service`。不要覆盖其他 Agent 的单元。以下配置是可调整的起点：

```ini
[Unit]
Description=CardBush Agent A
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cardbush-agent-a
Group=cardbush-agent-a
WorkingDirectory=/opt/cardbush/current
ExecStart=/usr/bin/node /opt/cardbush/current/dist-electron/agentServiceCli.mjs --transport http --data-dir /srv/cardbush/agent-a --name Agent-A --host 127.0.0.1 --port 4780
Restart=on-failure
RestartSec=5
TimeoutStopSec=40
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`NoNewPrivileges` 限制服务及子进程通过执行程序获得新权限，会影响依赖提权的插件；优先按项目权限配置普通账号，不能遇到错误就放开 root。若另加文件系统或系统调用限制，按实际项目、编译器和插件需要验证，避免套用使工具失效的通用模板。参见 [systemd 执行环境说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。

先检查单元，再加载和启动：

```sh
systemd-analyze verify /etc/systemd/system/cardbush-agent-a.service
sudo systemctl daemon-reload
sudo systemctl enable --now cardbush-agent-a.service
systemctl is-active cardbush-agent-a.service
journalctl -u cardbush-agent-a.service -n 50 --no-pager
```

日志输出可能含模型或插件错误，转交前脱敏。只有变更本实例配置时才重启本实例；不要重启整台主机或所有服务。隧道与 HTTPS 配置见 [网络接入与安全](network-security.md)。

## 本机 HTTP

本机也独立启动 HTTP 服务：

```sh
node /absolute/path/cardbush/dist-electron/agentServiceCli.mjs --data-dir /absolute/path/agent-a --name Agent-A --port 4780
```

Windows 使用 Windows 绝对路径。在 CardBush「Agents → 添加 Agent」填写 `http://127.0.0.1:4780` 和令牌。关闭应用或移除连接不停止服务；通过独立的进程管理方式启动和关闭它。旧 stdio 连接需改为 HTTP，使用原数据目录即可保留历史；不要同时启动两个进程访问该目录。

## 接入与验收

- 确认进程以预期普通账号运行、数据目录和日志可写，HTTP 仅监听预期回环地址。确认服务进程树中没有启动桌面 Electron。
- 无令牌、错误令牌请求 `/health` 必须返回 `401`；正确令牌必须返回实例信息；正确令牌但带 `Origin: null` 仍必须被拒绝。凭据从受限文件或安全配置读取，验证脚本只输出状态、实例 ID，不输出令牌或请求头，不使用 `curl -v` 或 shell 跟踪。
- 使用 HTTP 客户端或 CardBush 真实连接读取 `/api/agent/v1/info`，核对 `apiVersion: 1`、Agent ID、平台与能力，再用 `/api/agent/v1/call` 读取 `sessions.list`。HTTPS 必须用最终域名验证，不能只测后端回环地址。
- 添加连接后，在「管理此 Agent」单独配置模型、服务器项目、插件与全局指令。模型已配置且测试已获授权时，验证简单对话、SSE/NDJSON 实时事件、按 `afterSequence` 或 `Last-Event-ID` 补读及独立任务停止；观察事件流没有被代理缓冲或截断。取消事件读连接不能停止任务。
- 核实安装的 skill 能被列出和读取，验证资源路径存在。若未安装某些资源或模型未配置，在交付中明确说明。

不要在例行健康检查中创建收费模型调用、停止用户任务或重启忙碌实例。首次空实例可进行一次重启并核对 ID 与配置保留情况。

## 更新与恢复

在新版本目录完成构建、静态检查及独立临时目录的启动检查，再切换正式服务。已有实例先检查运行和排队任务；若会中断未获授权停止的任务，应等待空闲或协调维护时间。

停止实例后备份数据目录、原服务配置、当前版本和内置资源；备份需有相同的访问保护。保留 `agent.json`、`runtime-state`、`config`、`plugins`、`skills`、`bundled`、`AGENTS.md` 和 `access-token`。只备份静止目录或一致性快照，不在两个进程之间共享该目录。

更新后复查鉴权、实例 ID、模型配置、项目和历史。排队任务会恢复；中断中的任务不会自动重复执行。发现问题先停止新进程，再恢复旧代码及兼容资源。若涉及数据格式变化，确认旧代码是否兼容；恢复备份会丢失备份之后的状态，不能静默覆盖。恢复前先保留失败现场，并说明会影响的数据。
