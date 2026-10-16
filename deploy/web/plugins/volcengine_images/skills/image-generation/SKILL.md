---
name: image-generation
description: 用户请求生成、编辑图片，转换尺寸或 PNG/JPG/WebP 格式，多图拼接、批量看图或对比个人图片时使用。不支持视频。
---
先理解用户的图片需求，已有参考图只传当前账号 workspaces 目录内的绝对路径。使用 seedream_create_task 提交一次异步任务，request_id 唯一且在回执丢失时复用。使用 generation_wait_tasks 等待同一 task_id，仅 status=timeout 时继续等待；不要重新创建任务来查询进度。等待不取消后台生成。成功后用 Markdown 图片语法展示返回的 local_path。失败或结果未知时说明情况，绝不自动重试付费请求。禁止终端、视频、任意网址、跨账号路径和修改权限。

如果只需要改为指定像素尺寸或转换格式，使用 image_convert，不调用生图模型。把“800*800”等要求转成 width=800、height=800，output_format 支持 png、jpg、webp；仅转格式时同时省略宽高。默认 fit=contain，等比缩放并在空余处补白，保持原图完整。用户明确要求铺满裁剪或拉伸时才使用 crop 或 stretch。转换保留原图，结果自动保存到本账号 generated 目录；用 Markdown 图片及返回的绝对 local_path 展示，产物入口支持单张和全部下载。每张图最长边 8192、总计 1600 万像素，文件不超过 16 MB。

多图拼接使用 image_stitch，source_paths 按用户指定顺序传入 2–64 个本账号图片绝对路径；不要调用生图模型重画素材。layout 支持 grid（默认自动网格，可指定 columns）、horizontal（横排）、vertical（竖排）。默认每格 384×384、等比缩放保留整图、白底、间距 8 像素、带序号，输出 JPG；支持调整 cell_width、cell_height、gap、padding、numbered、output_format。单格尺寸不等于最终总图尺寸，横排/竖排过长时缩小单格或改为网格；总图最长边 8192、总计 1600 万像素、文件不超过 16 MB。超过 64 张则分组处理，明确各组数量，不能只取前 64 张而省略其他图片。拼接不覆盖原图。

需要比较或检查多张图片时，先用 image_stitch 生成带编号的总览，再用 inject_image_input 查看总览的 local_path。编号与 result.sources 的原图路径一一对应，查看顺序为从左到右、从上到下；细节看不清时再打开对应单张原图。生成拼图本身不代表已经看过或验证图片内容。展示拼图的 Markdown 图片和下载产物，按实际看图结果描述，不能仅凭任务成功宣称画面符合要求。
