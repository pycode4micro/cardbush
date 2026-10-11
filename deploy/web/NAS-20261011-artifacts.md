# NAS 产物下载更新

目标：`http://172.16.20.29:5199/`。发布根目录：`/volume1/docker/cardbush-web/releases/web-20261009-01`。

发布镜像 `cardbush-web:20261011-11` 基于正在使用的 `cardbush-web:20261010-10`，仅替换 `dist-web`。复用 Electron 产物菜单，为网页补充原图下载适配。生图回复下方“产物 → 下载”保存本轮图片，兼容历史 Markdown 图片和工具成功回执。只读取当前账号个人目录的生成图片，参考图和视频不计入产物。

展开菜单才读取历史工具详情，重复请求合并；下载复用个人图片缓存，退出/切换账号会使旧缓存及请求失效。未完成任务继续原生异步执行，图片模型仍由管理员配置 `doubao-seedream-5-0-flash-260915`。

验证：20 项产物识别、消息投影、个人路径和账号缓存测试；TypeScript 检查与生产构建；浏览器实际下载（正文有图、历史只有成功回执），下载文件 SHA256 与夹具原图一致，图片仅读取一次。夹具使用合成数据，不调用模型。`tmp/web-transcript-browser/artifact-download.jpg` 为界面验收图。

`updates/artifacts-20261011-11` 保存精确发布文件、原生渲染依赖快照、SHA256 清单和上线证据。新旧镜像的服务端、Runtime、文件权限、模型提供方与 broker 文件逐个比对，保持一致。发布仅在账号任务空闲时重建 web；broker 和账号容器不更新，用户卷及配置不变。

回退：恢复 `backups/before-artifacts-20261011-11/compose.yaml`，在确认没有活动任务后执行 `docker compose --project-directory /volume1/docker/cardbush-web/releases/web-20261009-01 -f /volume1/docker/cardbush-web/releases/web-20261009-01/compose.yaml up -d --no-deps web`。不要删除用户卷。源文件与清单另存于该备份目录。
