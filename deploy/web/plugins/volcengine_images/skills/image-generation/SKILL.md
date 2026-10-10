---
name: image-generation
description: 用户请求生成或编辑图片时使用火山 Seedream 图片插件。不支持视频。
---
先理解用户的图片需求，已有参考图只传当前账号 workspaces 目录内的绝对路径。使用 seedream_create_task 提交一次异步任务，request_id 唯一且在回执丢失时复用。使用 generation_wait_tasks 等待同一 task_id，仅 status=timeout 时继续等待；不要重新创建任务来查询进度。等待不取消后台生成。成功后用 Markdown 图片语法展示返回的 local_path。失败或结果未知时说明情况，绝不自动重试付费请求。禁止终端、视频、任意网址、跨账号路径和修改权限。
