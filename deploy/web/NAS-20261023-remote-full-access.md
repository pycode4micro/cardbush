# 网站远程子 Agent 完全访问

部署镜像：`cardbush-web:20261023-27`。

管理员明确授权后，网站网关向已注册、已授权的远程 Agent 提交新子任务时，统一使用 `permissionMode: all_free`。父会话传入 `task_free` 时也采用此项管理员策略；远端运行时会直接授予工具申请的能力，避免等待网站尚未转发的远端权限确认。

运行时变更仅包含 `dist-electron/webRemoteAgentBridge.mjs`。CardBush 桌面端与原生权限处理没有修改；网站注册授权、账号和父会话归属、SSH 身份校验、撤权取消、并发限制继续保留。

## 验证

- 本地及 NAS 新镜像内 16 项远程 Agent / SSH 测试通过。
- 新镜像内 TypeScript 严格检查通过。
- 网关测试确认父会话传入 `task_free` 或 `all_free`，远端提交参数均为 `all_free`。
- NAS 实际网关已更新，健康检查与静态资源一致性验证通过；已授权远端的 SSH 连接与清单读取通过。
- 模型设置、远程注册表及其授权数据的前后摘要一致。没有提交新的模型请求或业务委派任务。
- 系统管理员原先卡住的父任务和子任务均已确认停止；旧运行不能原地修改权限，新一轮派发才采用完全访问。升级后管理员租户已就绪，原任务仍显示停止，没有活动任务或待处理授权。

发布目录：`/volume1/docker/cardbush-web/releases/web-20261009-01/updates/remote-full-access-20261023-27`。

回退资料：`/volume1/docker/cardbush-web/releases/web-20261009-01/backups/before-remote-full-access-20261023-27`。
