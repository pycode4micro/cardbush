# SSH 远程子 Agent 与自动切片技能

已部署镜像：`cardbush-web:20261022-25`。
网站：`http://172.16.20.29:5199/#/admin`。

## 变化

- 远程 Agent 注册支持 SSH 隧道和原有 HTTP(S) 直连。
- SSH 支持密码、私钥及私钥口令；首次核对主机指纹，变化时拒绝连接。
- 复用原生 `openSshTunnel`，目标固定远端 `127.0.0.1` 的 Agent 端口；无本地监听、shell、SFTP、自动部署或本地子 Agent 装配。
- SSH 秘密与 Agent token 一起加密保存，界面只返回存在标志。保留一实例一人员绑定、授权检查、并发上限和撤权取消机制。
- 隧道断开后下一次操作重连；委派仍使用原生任务 ID 和事件游标，连接层不重复提交操作。
- 网站允许读取内置 `auto-video-slicing`，仅新增该技能目录的只读访问范围，其他工具权限保持原状。
- 切片交接必填手机号、主播、原厂款号或商品 ID、千川账号 ID。缺项不委派；远端完成一条就上传一条，名称用下划线分隔。

使用方法见 [REMOTE_AGENTS.md](REMOTE_AGENTS.md)，技能位于 `assets/skills/auto-video-slicing/SKILL.md`。

## 发布和验证

- 从线上 `cardbush-web:20261020-24` 派生；仅修改 `agentService` 的网站策略块，不包含桌面/CLI 正在开发的其他改动。
- 沿用上一发布冻结的渲染依赖，合入本次管理页。后端包产物未改变；运行时代码仅变更 `webRemoteSsh`、`webRemoteAgents`、`webRemoteAgentBridge`、`agentService` 四个模块。
- TypeScript 检查和网页构建通过。
- 33 项测试通过，覆盖 SSH 密码/加密私钥认证、主机身份、通道边界、重连、事件重放、异步委派、账号隔离、撤权，以及受限租户的技能搜索/读取。
- NAS 验证健康检查、前端文件内容、管理员 SSH 配置入口、普通用户拒绝、禁止本机目标、凭据脱敏、技能文件和允许列表。
- 模型配置未改变，现有远程注册表未改动，未中断活跃任务，未调用付费模型或实际制作/上传视频。
- 当前浏览器控制关闭，未进行人工页面交互验收。管理员仍需填写真实远程服务器信息并检测连接。

发布目录：`/volume1/docker/cardbush-web/releases/web-20261009-01/updates/ssh-agents-20261022-25`。
备份：`/volume1/docker/cardbush-web/releases/web-20261009-01/backups/before-ssh-agents-20261022-25`。
网关镜像和 broker 的租户镜像均指向新版本；broker 自身版本未改变。按原机制仅在旧租户空闲时替换容器，个人数据卷保留。
