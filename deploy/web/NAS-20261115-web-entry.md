# 网站入口移除切片指导

2026-11-15，已部署到 `http://172.16.20.29:5199/`。

## 问题与改动

管理员原会话在回答“你能做视频生成么”时没有调用工具，直接把网站的本地限制当成全部能力，声称只能做百应切片。用户提醒后才查到已授权的“视频生成助手”。首次误答发生在检索 Skill 之前。

按用户要求，从网站注入给模型的 developer 提示中删除整段百应切片指导，包括四项必填、手机号核验和指定自动切片技能；同时删除身份提示里两处切片专属描述。切片业务规则保留在现有技能中，技能文件和授权清单未改变。

通用远程助手提示新增：判断请求能力是否可用前，先用 `list_subagent_options` 查询本账号已授权助手；结合返回的名称、描述和本地工具回答，不能用本地缺少工具推断远端也不能做。

现有身份、账号隔离、本地操作限制、图片工具和异步任务规则移入独立的 `web-restricted` 模板，含义保持一致。本机源码使用现有 `renderPromptTemplate` 接口。NAS 旧版本沿用原有 Markdown 提示加载方式，部署模板已填入固定身份和旧版 `solution_selection` 工具名；未引入新版 Runtime API。

## 部署

- 租户镜像：`cardbush-web:web-entry-20261115`，基于 `cardbush-web:material-review-20261114`。
- 切换前确认全部运行租户无活动任务；短暂停止 Web 接入并再次检查，更新 broker 的租户镜像字段，重建 broker，通过既有 `ensure` 更新空闲管理员租户，再恢复 Web。
- Web 网关仍为 `cardbush-web:question-relay-20261114`，broker 本体仍为 `cardbush-web:runtime-loop-20261114`。其他租户在下次使用且空闲时由既有机制升级。
- 部署前两条原会话和 59 条任务记录保留。验证另建会话，结束后已归档。
- 配置备份：`/volume1/docker/cardbush-web/releases/web-20261009-01/.codex_backups/web-entry-20261115/broker.json`，权限 `0600`；原配置仅修改 `image` 字段。
- 回滚：等待租户空闲，恢复上述 broker 配置，重建 broker，并通过 `ensure` 将空闲租户恢复到原镜像。用户数据卷不回滚。

[旧版本补丁](patches/web-entry-20261115.patch)只适用于上述 NAS 基础镜像，不直接套用当前开发分支。[构建文件](patches/web-entry-20261115.Dockerfile)使用应用该补丁后的五个文件作为构建上下文。

对比基础镜像中的 2,089 个代码与资源文件，差异仅为两份提示、`agentService` 源码与对应模块、现有集成测试中的入口提示断言。上线后实际租户的模块与提示 SHA-256 与候选一致。切片技能 SHA-256 仍为 `dbf2fd905bc54b2157f638f34c69e754255ad22916cde44bf677c3b91a51ef9a`。

## 验证

- 本机平台构建与 `tsconfig.node.json` TypeScript 编译通过；远程助手与 SSH 相关 19 项测试通过；提示模板语言检查通过。
- NAS 候选镜像相关套件 16 项中 15 项通过。唯一失败是已有断言仍期望委派 schema 不含 `files`，基础镜像同一断言也失败。本次未修改该 schema 或放宽断言。
- 本机广泛模板快照测试存在原有 `assistant-management` 摘要不匹配；该模板及摘要夹具相对 HEAD 无改动。本次没有更新无关摘要掩盖失败。
- 部署后在实际租户运行入口集成测试通过：模型请求中的 system/developer 提示包含通用能力发现规则，不含百应、千川、切片或 `auto-video-slicing` 指导；技能仍能在按需检索和读取后使用，远程委派正常。
- 网站健康检查正常。北京时间 09:35–09:36，使用当前默认模型在新会话复现“你好”→“你能做视频生成么”。第二轮首先调用 `list_subagent_options`，返回“视频生成助手”，随后明确回答“可以做”。这一轮只有一次只读工具调用，没有切片、百应手机号或验证码要求，没有派发生成或上传任务。

验证会话：`web-b65f4601859e14f39b8edced37ea1722d893c156`；能力验证轮次：`turn-18d4ba02-e8d6-4e77-a16d-89e3cdb7a739`。这验证了能力发现与回答，不代表视频制作和上传的端到端验证。

本机详细证据：`C:/Users/EDY/AppData/Local/Temp/cb-web-entry-20261115/`，包含 `live-verification.json`、`image-verification.json`、实际租户集成测试和部署日志；未保存登录密码或会话 Cookie。未提交 Git。
