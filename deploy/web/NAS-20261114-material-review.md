# 素材 ID、回执行高与上传前成片确认

2026-11-14。修改范围为 53 专用千川回执包装器及相关技能、NAS 的视频交接技能；不修改 CardBush Runtime、Web 渲染器、账号权限或广告能力。

## 素材 ID 和现有记录

旧表中的 `v280…` 来自千川官方 `video_id`，不是模型编造，但业务需要的是同一响应中的 `material_id`。现在工具参数只接受留空的 `material_id`，由宿主从确认上传的官方回执填入；不能用视频、图片或生成任务 ID 替代。官方响应与包装器字段冲突、缺失或不精确时保留待处理回执，不再次上传。

ID 按字符串写入设置为文本格式的列，并在工具顶层以字符串返回，避免 19 位 ID 经 JavaScript 数值或表格数字格式损失精度。原始视频 ID 和官方响应仍保存在私有上传账本中。

真实表格 `2c40ea` 已完成以下定向修改，并回读确认其余单元格未变：

| 位置 | 内容 |
| --- | --- |
| C1 | 素材ID |
| C2 | `7707918779946647561`（原联调素材） |
| C3 | `7707944820161347647`（原实际生成素材） |

全表当前 202 行已调用接口设为 40 像素。后续新增回执写入并回读成功后，也设置对应行高为 40；完整 Markdown 脚本和标签不截断。格式失败持久化为 `receipt_formatting`，重试只检查原行并设置格式，不重新追加或上传。

行高使用飞书 `PUT /sheets/v2/spreadsheets/:token/dimension_range`；行范围为从 1 开始且包含起止行，`fixedSize` 单位为像素，见[官方 CLI 的更新行列实现](https://pkg.go.dev/github.com/larksuite/cli/shortcuts/sheets/backward#SheetUpdateDimension)。实际设置接口已确认成功；本次没有通过浏览器测量视觉行高。

## 命名与确认

旧交接模板固定包含“切片”，被生成任务继承。现在 AI 生成使用 `yyyy-mm-dd_Ai_生成_款号_主播名`，真正的回放切片才使用“切片”；已有文件按用户提供的合理名称上传，回执标题与上传名称保持一致。已经上传的历史素材未改名，也未为改名重新上传。

父子技能采用两阶段交接：

1. 子 Agent 完成制作，将实际成片放进工作区并在最终回复链接，使宿主完成文件传递；阶段结果标为 `ready_for_review`。该标签是工作说明，不增加 Runtime 任务状态。
2. 父 Agent 在最终回复包含已传回、用户能播放的视频及目标账号、素材名，请用户确认。只给远端路径或文字摘要不算交付。
3. 用户看过该版本后明确确认，父 Agent 才续接原子任务执行仅上传阶段，沿用同一文件、版本/哈希和脚本上下文。文件或目标账号变化需重新确认。

子任务不能在最终文件传递之前阻塞于 `ask_parent` 等待观看确认；也不能将最初的“制作并上传”、工具完全访问权限或 `confirm=true` 自身当作观看后的用户确认。回执仍由子 Agent 根据提示词和既有上下文编写，不为了填表观看视频。

以上是用户要求的 Skill/工具说明规则，未新增伪称能证明人已观看的技术令牌或新审批系统。

## 部署和验证

- 53 更新 `receipt_schema.py`、`receipt_presentation.py`、`receipt_sink.py`、`restricted-entry.py`、千川 operator skill 及其生成的 JSON Schema；备份在 `D:/CardBushAgent/backups/material-receipts-20261114`。插件已重新连接，仍只暴露图片上传、视频上传、回执状态和回执重试四项工具。
- 53 同步视频交接、Seedance 电商生成和参考生成 skill，实际 `conversation.catalog` 回读一致。测试、迁移脚本及候选文件保存在 `D:/CardBushAgent/diagnostics/material-receipts-20261114`。
- 飞书迁移及账本备份在 `D:/CardBushAgent/data/private/qianchuan-receipts/backups/material-id-20261114`，保留修改前的表格值、两份原账本和设置行高的接口回执。
- NAS 租户镜像为 `cardbush-web:material-review-20261114`，基于上一版 `cardbush-web:skill-routing-20261114`。对比 2,087 个代码/资源文件，仅 `assets/skills/auto-video-slicing/SKILL.md` 改变。Web 网关仍为 `cardbush-web:question-relay-20261114`。
- NAS 发行目录的 `config/broker.json` 仅修改 `image` 字段，已备份至 `.codex_backups/material-review-20261114/broker.json`，权限 0600。重建 broker，并通过既有空闲保护机制加载新租户镜像；未中断运行任务。实际租户读取到新 skill，SHA-256 为 `dbf2fd905bc54b2157f638f34c69e754255ad22916cde44bf677c3b91a51ef9a`。
- [NAS 补丁](patches/material-review-20261114.patch)、[构建文件](patches/material-review-20261114.Dockerfile)。回滚需在无活动任务时恢复原租户镜像值并重建 broker；回执代码和已迁移的表结构需保持配套，不能只恢复旧代码却保留新列名。
- 32 项隔离回执测试在本机和 53 通过，包括精确素材 ID、防伪造、图片素材 ID、行高失败恢复、格式请求超时、丢失追加回执后的对账和不重复上传。真实 MCP schema 与飞书只读就绪检查通过，父 Web 健康检查正常。
- 本次未生成新媒体、发送验证码、上传千川或新派业务任务，因此不将技能加载验证描述为新的端到端用户确认流程已经实测。

本机证据目录：`C:/Users/EDY/AppData/Local/Temp/cb-material-receipts-20261114`。未提交 Git，未将凭据写入仓库。
