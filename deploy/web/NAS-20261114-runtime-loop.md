# 远端 Runtime 重复回执与摘要顺序修复（2026-11-14）

## 范围

已检查并更新 NAS `172.16.20.29:5199` 的实际会话宿主，以及 Windows Agent `172.16.20.53`。两者原来均会监听已经同步返回终态的 Assistant 子任务，导致同一结果再次唤醒模型；同批 `summary_for_user` 也可能提前执行。

按用户最后限定，NAS 只修复这两个问题并移除 `page_write` 工具入口。没有升级整个应用，也没有修改前端、插件、模型、权限或用户数据。53 只替换三个 Runtime 模块及对应类型声明、映射文件。

## 实现与版本差异

- Assistant 根据本次回执的 `status` 决定是否登记监听。`completed`、`failed`、`stopped`、`unavailable` 不登记；`running`、`message_queued` 仍登记，包括任务先于 running 回执完成的竞态。
- NAS 旧版 `await_subagents` 返回已完成结果时也会重复登记监听。本次将这类已消费结果从待监听集合移除，并标记为已通知；未完成的任务仍正常唤醒。
- Assistant 与普通会话分两阶段执行同批工具：其他工具结束后再执行 `summary_for_user`。回执顺序、调用 ID、原始 ordinal、通道并发和命令批次串行约束保持不变。
- 53 包含原生和 conversational 两条 Assistant 分派路径，以及普通会话 `call_tool` 间接调用；均已覆盖。NAS 的旧协议只含 conversational Assistant，尚无该版本的原生分派和内置 `call_tool` 路径，不为修复引入这些新功能。
- NAS 移除了 Assistant 的 `page_write` 暴露、执行分支和主动提示，最终文本仍支持 Markdown；历史 `source: page` 数据继续可读。已发布协议包中的兼容定义保留，未整包升级协议或改写旧会话契约。

NAS 使用基于线上旧版的 [有限回移补丁](patches/runtime-loop-20261114.patch)。补丁只包含三个 Runtime 源模块和相关测试；不能直接应用到当前开发分支。

## 部署

NAS 基础镜像：`cardbush-web:remote-media-20261114`。

新镜像：`cardbush-web:runtime-loop-20261114`，ID：
`sha256:8e91a5b52cb72389f6a4a4405f3ae70ef6e9a314ba4d120e23c1618da9a52465`。

只执行 Runtime TypeScript 构建。构建前后完整 Runtime 文件清单比对确认：变更仅为上述三个模块、对应构建产物及测试。

先检查任务空闲，短暂停止 Web 接入并再次检查，再更新 compose 与 broker 的目标镜像。网关、broker 和管理员实际会话容器均已重建并加载新镜像。其他已停止租户保留数据卷，在下次打开、空闲时由既有 broker 机制更新。

NAS 配置备份：发行目录 `/volume1/docker/cardbush-web/releases/web-20261009-01` 下的 `.codex_backups/runtime-loop-20261114`。备份保持私有；broker 配置保持 `root:root`、`0600`。回滚时恢复备份中的镜像选择并强制重建 web/broker，再通过 broker 更新空闲租户。

53 备份：`D:/CardBushAgent/backups/runtime-loop-20261114`。在确认无执行任务后正常停止 Agent，替换 `assistantConversation`、`runtimeToolLoop`、`toolScheduling`，通过原 `CardBush-Agent` 计划任务启动。回滚时同样先等空闲、停止服务，再恢复这些文件并启动。

## 验证

- 53：线上旧产物的隔离副本运行 87 项回归，66 通过、21 失败；修复副本 87 项全部通过。部署后直接加载线上模块再次运行 87 项，全部通过，并追加验证后续用户消息不会重投已消费结果。
- NAS：旧镜像专项 19 项中 3 通过、16 失败（含新的 page_write 下线要求）；新镜像相关完整回归 82 项全部通过。管理员实际会话容器再跑 19 项专项，全部通过。
- 专项覆盖终态立即返回、异步完成、完成竞态、摘要首位/中间/末尾、其他工具失败、原始回执编号、串并行约束及后续用户消息。
- 线上三个模块校验和均与通过回归的候选一致；进程已重启。NAS HTTP 返回 200，管理员 52 条任务记录、2 个会话保留；53 的 7 条任务记录保留。
- 测试使用模拟模型和临时数据目录，没有提交生成、千川上传或其他业务任务。

诊断证据保存在本机 `C:/Users/EDY/AppData/Local/Temp/cb-runtime-20261114`，53 的隔离验证目录为 `D:/CardBushAgent/diagnostics/runtime-loop-20261114`。不包含生产凭据。本次不处理独立的 `credential_key_file_required` 凭据故障。
