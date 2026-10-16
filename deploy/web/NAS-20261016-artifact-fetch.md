# NAS 全部产物下载修复

目标：`http://172.16.20.29:5199/`。镜像 `cardbush-web:20261016-13`，基于线上 `20261016-12`。

“下载全部”在打包时通过 `fetch(blob:...)` 重新读取图片预览地址，触发页面 CSP `connect-src 'self'`，因此显示 `Failed to fetch`。之前的浏览器夹具没有带线上 CSP，未覆盖这一限制。使用原发布资产、实际网关 CSP 已复现并记录 `connect-src` 对 `blob` 的拦截。

图片缓存现在同时保留原始 Blob 和预览 URL，打包直接使用原始 Blob；不放宽 CSP，不增加图片请求或复制图片数据。缓存引用计数、内存上限、账号隔离和退出清理沿用原逻辑。

生产源码基线只修改 `web/BrowserCacheProvider.tsx` 和 `web/NativeTranscript.tsx`。前端 TypeScript 检查、构建及 20 项回归通过。新增浏览器回归从网关源码读取 CSP，验证三张同名图片 ZIP 的内容哈希、重名编号、单张下载、重复下载不增加网络请求、刷新后的磁盘缓存恢复、网络失败重试、账号切换；修复后无 `connect-src` 拦截和页面脚本异常。

等待全部会话和图片任务空闲后，仅重建 web 网关。全部 `dist-electron` 和 `packages/*/dist` 文件哈希保持一致，broker 和账号容器保持原实例。线上健康检查、入口资源哈希、CSP、已认证分页/状态接口与跨账号拒绝验证通过。验证未调用模型或写入对话。

发布证据：`/volume1/docker/cardbush-web/releases/web-20261009-01/updates/artifact-fetch-20261016-13`。

回退：`/volume1/docker/cardbush-web/releases/web-20261009-01/backups/before-artifact-fetch-20261016-13/compose.yaml`。确认任务空闲后恢复 compose 内容，执行 `docker compose ... up -d --no-deps --no-build --pull never web`；保留账号卷和配置。
