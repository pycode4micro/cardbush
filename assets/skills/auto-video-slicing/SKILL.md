---
name: auto-video-slicing
description: Delegate video production and Qianchuan library uploads to authorized remote Agents. Route Baiying replay clipping, AI video generation, and existing-file uploads separately; Baiying login is required only when the requested work uses Baiying materials. Do not execute video tools locally on the website.
---

# 自动切片任务交接

这个技能在招财网站整理任务，通过现有远程子 Agent 执行。不得启动本地 Agent、自动装配模型或插件、执行 SSH 命令。SSH 连接由管理员配置，技能不接收连接密码、私钥、访问令牌、Cookie。

## Route the requested work before collecting inputs

Determine the workflow from the user's requested output and actual source materials, not from the presence of an anchor name, product code, phone number, or Qianchuan destination.

- **Baiying replay clipping:** when the task requires fetching or clipping Baiying replay materials, use the four inputs and clipping handoff below. Baiying account/product verification belongs to this branch.
- **AI video generation:** delegate the user's topic, anchor, product references or product code, requested duration/sound, and Qianchuan destination to an authorized generation-capable Agent. Use available anchor assets and product-image sources. Do not require a Baiying phone number, account lookup, login, SMS code, replay, or smart clipping unless the user also requests Baiying materials. A supplied phone number alone does not change this route.
- **Existing-file upload:** transfer the available file to an authorized upload-capable Agent with the target Qianchuan account and receipt context. Do not regenerate the video or require Baiying login. Report genuinely missing file/account information.

For generation or existing-file uploads, compose a handoff for that branch instead of copying the clipping template below. Preserve the user's objective and existing authorization; include only the inputs and capabilities needed for this task. State the required source workflow explicitly (for example, AI generation from product images, with no Baiying material dependency). Do not convert a product-code lookup into Baiying ownership verification. Keep the same-task waiting/resume, upload-only, result verification and no-duplicate-submission constraints in all branches. Use remote tools actually available on the target Agent.

An executing child Agent should follow the delegated task rather than applying this website handoff workflow again. If a handoff explicitly requires Baiying while the stated task has no Baiying dependency, clarify that conflict with the parent before initiating login or sending an SMS; do not silently expand the user's task.

## Deliver the video for review before any Qianchuan submission

Use two stages even when the original request says to generate/clip and upload:

1. **Produce and return for review.** The initial handoff ends with the finished video, its version or file hash, proposed material name, and target Qianchuan account. Instruct the child to save/register the exact deliverable and include its absolute Markdown file link in its final reply so the host can transfer it. Do not upload to Qianchuan at this stage. The child should end with `ready_for_review` rather than wait inside `ask_parent` before final file transfer.
2. **Parent displays the result and waits.** In the parent's final reply, include the actual transferred video attachment/Markdown file link that the user can play, plus the proposed target account and name. Use only the returned parent-accessible path/URL; a child-host path or a text-only summary is insufficient. Explicitly ask the user to confirm upload, and end the turn. Task permissions or the initial production request do not replace confirmation after viewing this exact version.
3. **Upload the approved version.** After explicit user confirmation, resume the original child with `task_id`, the exact reviewed file/version or hash, destination account and the user's approval. If that deployment cannot resume it, send an upload-only handoff carrying the existing artifact and context; never rerun generation/clipping. A changed file or account requires confirmation of that change. The child authors the receipt from original prompt/context and performs the upload/Feishu delivery; the parent does not reconstruct the script by viewing the video.

Do not report the whole workflow complete at `ready_for_review`. A file-transfer failure requires retrying transfer of the existing artifact, not uploading to Qianchuan as a shortcut. An already uploaded historical file is not to be reuploaded merely to adopt this workflow.

Name materials by actual origin: AI-generated videos use `yyyy-mm-dd_Ai_生成_款号_主播名`; use `切片` only for actual replay clips. Existing-file uploads keep the user-supplied name unless the user requests a change. Keep the receipt title consistent with the submitted filename. After upload, report the official `material_id` string (素材ID), not `video_id`, generation task ID, or an invented ID.

## 必填输入

The following four-input requirements apply only to the Baiying replay-clipping branch.

每个任务必须有以下四项。先从用户当前任务及已明确的上下文提取；缺项时只询问缺少的内容，补齐前不委派、不登录、不切片、不上传。

| 字段 | 要求 |
| --- | --- |
| 登录手机号 `login_mobile` | 百应登录手机号，按字符串保存；中国大陆号码为 11 位数字，可去掉空格和 +86。不沿用其他任务的“最近登录账号”。 |
| 主播名称 `anchor_name` | 明确的主播名称，用于核对所属子账号及命名；不能根据手机号猜主播。 |
| 原厂款号 / 商品 ID `products` | 至少一个原厂款号或商品 ID。多项支持逗号、中文逗号、分号、中文分号、换行；分别标明 `factory_style_code` 或 `product_id`，去重后保持顺序。不把款号当商品 ID，数字 ID 按字符串保存。 |
| 千川账号 ID `qianchuan_account_id` | 视频库接收账号的数字 ID，按字符串原样保存，不能替换成百应 ID、达人 ID 或用户手机号。 |

同批多个主播或手机号时，按每组“手机号 + 主播 + 千川账号”拆分任务；每组都要完整。商品 ID 和款号同时给出时要求远端核对是否同一商品。条数、时长、素材日期和剪辑偏好按用户本次要求传递；没有指定就明确写“未指定，由现有剪辑技能默认值处理”，不伪造用户要求。

## 选择与委派

1. Use `list_subagent_options` to choose an authorized remote Agent with the capabilities needed by this branch and stage: generation, replay clipping, or existing-file upload. Do not require Baiying capabilities for generation or upload-only work. If several targets cannot be distinguished, ask the user to select; if none qualifies, report the missing authorized target without installing tools or running locally.
2. 组织下方完整交接文本并用 `subagent` 的 `target_agent`（列表返回的精确 ID）和 `prompt` 异步委派。只发送本任务所需字段与要求，不复制整个会话、SSH 凭据、其他用户资料或网站个人文件路径。
3. 保存返回的 `taskId` 和目标。用 `tasks action=wait` 等待原任务；需要检查状态时用 `tasks action=conversation`。远端等待验证码、账号选择或商品消歧时，将明确问题交给用户；补充内容用 `subagent` 的 `task_id` 继续原任务，不能换成新建任务。
4. 不因等待超时重新发送制作/上传。登录验证码优先让用户在远端认证交互中输入，不将验证码持久化进技能或交接清单。用户撤销授权或停止时遵守当前可用的任务控制机制；无法确认远端停止就如实说明。

## 交接文本

Use this template only for Baiying replay clipping, not AI generation or existing-file uploads.

将占位值替换成实际输入，明确区分事实、用户要求和默认策略：

```text
任务：制作百应商品切片，先回传成片供用户确认，再上传到用户指定的千川视频库。
登录手机号：{login_mobile}
主播名称：{anchor_name}
商品清单：{逐项列出 factory_style_code / product_id，ID 均为字符串}
千川账号 ID：{qianchuan_account_id}
每款条数 / 时长 / 素材日期：{用户要求，未指定则明确标注}
剪辑要求：{用户已明确的开场、字幕、花字、转场等要求；没有则使用远端技能默认值}
终点：{本次阶段：制作并回传待用户确认，或用户确认具体成片后的仅上传；仅规划/备料请求保持原终点}

执行约束：
- 先发现本远程服务可用的百应、视频剪辑、千川上传工具及技能；能力缺失时报告缺口，不自动安装、不编造工具名，不把“提交成功”当成完成。
- 全程显式绑定上述登录手机号；查询真实百应账号并核对主播，逐项查询商品。多个命中先消歧，找不到的款号报告缺失，不私自换款或换主播。
- 使用远端已有素材准备和剪辑技能、持久化任务记录及异步队列。允许在已有素材不足时通过百应智能剪辑补充，优先复用可用素材；生成台词、配音或 AI 视频不是默认步骤。
- 仅使用真实原声和可核验素材。用户指定强情绪开场时从真实讲解中找完整句，不伪造主播台词；遵守用户字幕、花字、翻页转场等要求。
- Return each completed video to the parent for display and user review before uploading. Upload only the exact file/account explicitly approved after review. Do not wait for an entire batch to deliver available previews. Do not create ads or publish to another account.
- 名称各段用下划线分隔：yyyy-mm-dd_Ai_切片_原厂款号_主播名。多条同款追加 _01、_02。只有商品 ID 且查不到原厂款号时用 商品ID{真实ID} 作为商品标识并说明，不能虚构款号。
- 保存每款的素材任务、剪辑任务、上传任务 ID 和官方素材 ID。超时查询原任务，已成功素材不重复制作或上传；部分失败保留成功项，恢复时只补失败项。
- 结果逐条返回：主播、真实款号/商品 ID、成片名称、时长、制作状态、目标千川账号 ID、素材 ID、上传状态、失败原因/待用户输入。上传成功必须有接口确认或可核验的视频库记录。
```

用户只要求查看计划/准备素材时必须修改交接终点，不触发制作和上传。展示最终结果时区分已完成、失败和待输入；部分完成不能声称整批完成。
