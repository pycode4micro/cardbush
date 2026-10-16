# NAS 产物流式下载

发布版本：`cardbush-web:20261016-15`，网站 `http://172.16.20.29:5199/`。

原实现先将本轮全部图片读入浏览器，再用 JSZip 合并；超过 128 MiB 会拒绝下载。现由网关向当前账号 Agent 逐段读取，每段最多 512 KiB，同一文件和同一下载内均串行。ZIP 使用已安装并明确声明为直接依赖的 `zip-stream@4.1.1`，STORE 模式避免重复压缩图片，ZIP64 支持大归档。流水线按接收端速度读取，服务端不生成临时 ZIP，浏览器不创建整包 Blob，也不将整包写入 IndexedDB。

POST `/api/web/v1/files/archives` 校验 CSRF、当前账号和会话归属，仅接受个人 `generated` 下 PNG/JPG/WebP，预先 describe 每个文件并检查规范路径。一次最多 1024 个路径，去重后创建五分钟有效、绑定账号及登录凭据摘要的随机下载票据。文件上限沿用 Agent 原生接口的 64 MiB，不再设 128 MiB 整包上限。同名文件自动增加序号。

GET `/api/web/v1/files/archives/:id` 再次核对身份与会话，通过原生浏览器下载管理器保存附件。状态接口只返回计数、字节数和错误。全局两个工作槽同时覆盖元数据准备及传输，每账号一路，等待队列最多 16 个、最多五分钟；就绪及结束票据过期清理，总清单数限制 256。每 15 秒复核身份；退出或停用账号立即终止活跃响应。慢接收端、连接取消和中途文件大小变化均会停止后续读取，失败归档不会记为完成。一个已派出的 RPC 最多完成当前分段后释放槽位。

验证共 52 项 Node 测试，含 32 张 / 160 MiB 完整下载、每个文件 SHA-256、唯一文件名、ZIP64、原生 `AgentWebFiles` 多分段文件读取、慢接收端背压、取消、退出、越界路径、票据登录隔离及有界排队。浏览器在生产 CSP 下验证下载、重试和缓存恢复；160 MiB 整包通过全部 CRC 和逐文件哈希校验。

首次真实文件验收发现读接口仅返回文件名而不返回完整路径，已修正校验并加入原生接口集成测试。修正后先在 NAS 独立验证容器中验收，再更新正式网关。只读根目录、单核、512 MiB 容器验证通过；正式网关成功下载四个真实产物，原图总量 18,337,025 字节，ZIP 18,337,779 字节，状态 completed。验证没有调用实际模型或写入用户对话。

编译后端只更新 `dist-electron/webServer.mjs` 并新增 `dist-electron/webArtifactArchives.mjs`；其余 Runtime、broker、账号容器及个人卷保持原有版本。发布前检查所有活跃账号无对话任务或后台生图，健康接口、静态资源 SHA-256、会话分页和账号隔离验收通过。

发布目录：`/volume1/docker/cardbush-web/releases/web-20261009-01/updates/stream-archive-20261016-15`。证据包括 `tests.log`、`browser-evidence.json`、`browser-large-evidence.json`、`canary-evidence.json`、`deployment.json`、`runtime-diff.json`。配置备份：`backups/before-stream-archive-20261016-15/compose.yaml`。如需回退，先确认任务空闲，恢复该 compose，只重建 web 服务到 `cardbush-web:20261016-14`，无需迁移个人卷或改动 broker。
