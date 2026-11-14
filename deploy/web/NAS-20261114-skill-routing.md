# 视频任务分流与商品图准备指引

2026-11-14，仅修改技能资料；NAS Runtime、协议、Web 网关、审批、账号、插件工具和飞书回执策略均保持原实现。

## 证据

真实任务 `webtask_032b1ee722749e000543ed603acde0f2ee0779566cca85c54cf866a237e3d0e2` 的父级交接明确说不是标准商品切片，但仍要求查询真实百应账号、核对手机号下的主播和商品。53 因此在 15:43 查询登录状态，15:44 发送验证码。它同时加载了 `auto-video-slicing`、`seedance-ecommerce-video`、`anchor-asset-registry` 和 `reference-video-production`。

旧交接技能只有百应切片模板，四项输入和百应账号验证没有先按任务类型分流。旧参考生成技能另有“真人图片优先局部遮罩……不强制重生成纯商品图”的说明，与本次需要的商品图生图预处理不一致。

实际首次视频请求在 15:47 被供应商以 `InputImageSensitiveContentDetected.PrivacyInformation` 拒收；用户补充说明后，53 改用图片生成制作无人商品图，再完成视频和上传。这里不能仅凭供应商错误码确定具体哪张图触发审核；实际调用记录证明首次视频提交前没有商品图生图步骤。

## 修改

- `auto-video-slicing` 先区分百应回放切片、AI 视频生成、已有文件上传。百应手机号、登录和账号商品核对只属于百应素材分支。生成和文件上传分别组织交接，不复用百应模板。
- `seedance-ecommerce-video` 补充无百应依赖的范围，以及首次视频提交前检查商品图、按需进入商品图生图准备的入口。
- `reference-video-production` 明确含真人模特的商品图先经图片生成/编辑，得到无人商品图并核对服装细节；无人的合适图片直接复用。主播身份/音色资产独立保留。真人视频继续使用适用的视频预处理工具。
- 保留现有生成授权、付费失败停止条件、Seedance 2.0 Fast、有声默认、同任务恢复、上传目的账号及强制飞书回执要求。

本次只查日志、修改指引和验证加载，没有重新生成媒体、发短信、上传千川或写飞书。

## 部署

53 已备份并更新以下文件，运行中的 `conversation.catalog` 清单和读取接口已回读一致，无需重启：

- `D:/CardBushAgent/release/assets/skills/auto-video-slicing/SKILL.md`
- `D:/CardBushAgent/data/skills/seedance-ecommerce-video/SKILL.md`
- `D:/CardBushAgent/data/plugins/volcengine-plugins/skills/reference-video-production/SKILL.md`

53 备份目录：`D:/CardBushAgent/backups/skill-routing-20261114`。本机仓库对应技能及本机 App 的 `seedance-ecommerce-video` 已同步修改，未提交 Git。

NAS 租户镜像：`cardbush-web:skill-routing-20261114`，基于 `cardbush-web:runtime-loop-20261114`，只复制更新后的交接 `SKILL.md`。对比 `assets`、`dist-electron`、`packages` 下 2,087 个文件，只有这一文件不同。

补丁：[交接 skill](patches/skill-routing-20261114.patch)；构建：[Dockerfile](patches/skill-routing-20261114.Dockerfile)。旧 NAS 的 `await_subagents` / `read_subagent_conversation` 用法保持原样，没有替换为新 Runtime 工具名。

发行目录 `/volume1/docker/cardbush-web/releases/web-20261009-01` 下仅将 `config/broker.json` 的 `image` 字段改为新租户镜像，然后重建 broker，按其现有空闲保护机制更新租户。切换前父子任务均无运行项。Web 网关仍使用 `cardbush-web:question-relay-20261114`。

NAS 备份位于发行目录 `.codex_backups/skill-routing-20261114`，含原 `broker.json` 与更新后的 skill。原配置备份权限为 0600。回滚需等待租户无活动任务，恢复该配置中的旧镜像值并重建 broker；不回滚用户数据或回执。

## 验证范围

- 两份标准 skill 通过 `quick_validate.py`；电商 skill 原有扩展字段 `description_zh` 不被该通用验证器识别，保留该字段。三份 YAML 均成功解析，既有名称和元数据字段完整保留，53 产品接口成功读取三份实际内容。
- 53 修改文件的相对参考链接在部署目标上存在。
- NAS 已运行新租户镜像，实际租户中的 `readProductSkill` 与 `listProductSkills` 读取新说明；内容 SHA-256 为 `ed6b01bfb2b11fe22fea79a846bea87e739c5fc2719c99bc1edb920190df5f2c`。
- NAS Web 健康检查正常，原会话无待答项、无活动任务，55 条历史任务保留。
- 本次是指引与加载验证，没有新派付费业务任务，不能把这些检查称为新生成任务的端到端通过。旧任务中的历史交接文本不重写；后续新任务使用更新后的技能。

本机诊断目录：`C:/Users/EDY/AppData/Local/Temp/cb-skill-routing-20261114`。生产凭据未写入本记录或补丁。
