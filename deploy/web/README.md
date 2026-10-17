# CardBush 多账号对话网站

网站直接使用 CardBush 的持久化 Agent 会话服务，替换旧 SOP 页面和执行入口。助手身份为“兆君服饰的招财”，开放经过服务端限制的个人文件读取、图片查看和按账号授权的图片插件。

默认工具是 `read_file`、`inject_image_input`、`solution_selection`、`checkpoint_context`、`search_skills`、`run_skill`。使用 `--web-restricted` 固定部署策略，模型声明和执行协调器同时检查工具上限。文件读取在插件钩子前后检查 canonical realpath；原生读取授权使用相同的个人目录范围。终端、任意写文件、浏览器、其他账号文件、配置密钥、视频和自动任务不开放。

管理员在“管理中心 → 插件管理”安装/停用/卸载经过审核的火山图片插件，并逐账号授权。当前目录仅提供图片插件，不支持上传任意插件代码。未授权账号不会得到图片工具。撤权在图片网关每次派发时生效，已发出的图片请求继续完成，空闲后通过原生插件生命周期移除该账号的插件；生成结果和任务回执保留。

上传支持静态 PNG/JPEG/WebP、UTF-8 文本、PDF、无视频/嵌入对象/宏的 DOCX/XLSX/PPTX。单个文件 16 MiB，每条消息最多 8 个附件、4 张图片、总计 24 MiB。分块暂存区与可读目录分离，验证完成才发布到个人目录。图片解码再编码；文档复用 CardBush 只读解析器，在独立的 128 MiB、12 秒子进程中生成有明确截断说明的文本附件。PDF 不含 OCR，表格预览目前仅包含第一个工作表。

粘贴、拖放和文件选择共用浏览器端图片预处理。原始静态图片最高 64 MiB / 6400 万像素；小于 4 MiB 且分辨率合适的图片保持原始内容，大图按比例优化至目标 4 MiB。截图优先无损 PNG（最长边 8192、1200 万像素以内），需有损压缩时使用保留透明度的 WebP（400 万像素以内），同时限制 NAS 重新编码为 PNG 后的文件大小。处理前识别实际文件格式并拒绝动图、视频和伪装文件；服务端的 16 MiB / 1600 万像素校验继续独立执行。界面显示优化前后大小、上传进度和取消操作，网络中断会使用相同上传 ID / 分块重试；一批附件中单个失败不影响其余附件。

图片上传回归：`node --test scripts/test-web-uploads.mjs scripts/test-web-files-ui.mjs scripts/test-web-cache.mjs`。本机浏览器夹具为 `node scripts/fixtures/web-upload-browser.mjs dist-web`（127.0.0.1:5209，alice/bob + 任意测试密码），提供生成的 2400 万像素截图与 23.4 MiB 图片，上传验证使用实际个人文件处理器，不调用模型或生产账号。

## 账号与数据边界

- `user_accounts`、`departments`、`auth_sessions` 兼容原网站，保留用户 ID、scrypt 密码、部门、审批状态；迁移不重置密码。新账号仍需要管理员启用，首个全新安装的账号为管理员。
- 新的 `cardbush_web_conversations` 表保存归属，所有读写、停止任务、事件流都先按登录用户验证，管理员也不能绕过归属读取别人的对话。
- 每个账号分配独立非 root 容器、命名卷、Agent 实例、运行数据库、会话上下文和个性化数据。对话 ID 和运行目录不接受浏览器指定。
- 运行容器只加入内部网络，没有公网、NAS 目录、Docker socket、共享可写目录或其他账号的卷。网站通过独立的模型代理连接管理员配置的模型，供应商密钥不进入用户容器或浏览器。
- 只有私有 broker 持有 Docker socket。其 API 只接受已经哈希的账号身份，固定镜像、启动参数和挂载；不向宿主机发布端口。需将 broker 视为受信任的宿主管理组件。
- 网站使用 HttpOnly / SameSite=Strict Cookie、原点检查和 CSRF 校验；退出登录、停用账号会关闭事件流，持续连接每 15 秒重新验证身份。HTTPS 站点增加 Secure Cookie；现有内网 HTTP 部署需继续限制在可信局域网。
- 不修改原 Agent HTTP API 的 Origin / Bearer 限制。网页只使用新的、受限的 `/api/web/v1` 协议；原始 owner API、任意 Runtime/Product 命令不向网页开放。

## 公司、部门与人员管理

系统管理员进入“管理中心 → 组织与人员”，从左侧组织树按公司或部门查看人员，也可搜索姓名、用户名、公司、部门并按启用状态筛选。

- 组织树右上角新增公司；选择公司后可编辑公司、新增部门；选择部门后可编辑名称、说明或调到另一家公司。部门名称在同一公司内不能重复，不同公司可同名。
- 新增和编辑人员支持姓名、用户名、所属公司/部门、角色、启用状态及密码。修改部门不会改变账号 ID、个人文件夹或会话归属，也不会注销登录。
- 有部门的公司、有人员的部门不能删除，必须先调整下级。删除人员会撤销登录与插件授权、移入“已删除”，保留其用户名、账号 ID、对话和文件。恢复后为待启用、待分配状态，插件需重新授权。
- 当前登录的管理员不能删除、停用或降低自己的权限。组织管理仅向系统管理员开放；部门管理员和成员不能通过直接调用接口管理其他账号。公司或部门归属不授予读取他人会话和文件的权限。
- 原账号未分配部门时继续显示在“待分配”，不自动推测公司。旧部门迁移到“原有组织”公司，管理员可改名或调整。注册页支持先选择公司再选择部门，审批流程保留。

迁移兼容旧 NAS 表没有数据库默认值的情况；新增人员/部门显式写入启用状态、权限及时间字段。组织修改使用事务并重新验证管理员权限，避免并发请求沿用已失效的管理权限。

独立 PostgreSQL 回归：设置 `CARDBUSH_TEST_DATABASE_URL` 指向新建的空测试库 `cardbush_web_organization_test` 后运行 `node --test scripts/test-web-organization.mjs`。该测试不应连接产品数据库；它覆盖旧表迁移、三级增删改查、调整归属、删除恢复、登录失效和权限校验。

## 配置与运行

1. 备份原 PostgreSQL 数据库和网站入口，确认没有需要中断的旧任务。
2. `docker build -f deploy/web/Dockerfile -t cardbush-web:RELEASE .`
3. 将 compose 文件放入独立部署目录；复制两个 example JSON 到 `config/web.json` 和 `config/broker.json`。生成两个不同的高强度随机 secret，替换数据库、模型和域名；配置文件仅允许运行 UID 1100 与管理员读取，禁止提交 Git。
4. 配置环境变量：`CARDBUSH_WEB_IMAGE`、`CARDBUSH_IDENTITY_NETWORK`（现有数据库所在网络）、`CARDBUSH_WEB_BIND`。预检先保留默认的 `127.0.0.1:5198`；允许 SSH 转发时可用隧道访问，禁止转发时直接在服务器上检查接口，不要修改 SSH 策略。`origin` 必须与浏览器实际访问的源一致。
5. `docker compose up -d`。第一次打开某账号的对话时创建容器；最多同时运行 3 个账号，忙碌实例不会被淘汰。空闲 10 分钟后停止，命名卷和会话历史保留。
6. 用两个测试账号验证注册审批、历史恢复、流式回复、跨账号访问拒绝、上传内容验证、方案选择、插件撤权以及工具边界。

管理员通过“管理中心 → 模型管理”新增、编辑、启停和删除对话模型，设置默认模型、接口协议、模型 ID、服务地址、最大上下文、最大输出和思考强度，也可修改生图模型 ID 和密钥。默认模型必须保持启用，删除或停用前需先选择其他默认模型。对话模型默认最大输出 128000、思考强度中；最大输出必须小于上下文长度。保存后新请求使用新配置，不需要重建容器；普通用户只有模型选择权，没有供应商密钥或服务设置权限。

首次启动从受保护的 `web.json` 导入模型配置，随后以 PostgreSQL 的 `cardbush_web_model_settings` 为准。配置使用 `modelSecret` 派生的 AES-256-GCM 密钥加密保存，管理接口仅返回是否已配置密钥，编辑时留空保留原密钥；更换服务源必须重新填写密钥。并发修改使用版本校验，防止覆盖其他管理员的更改。备份和恢复时必须同时保留数据库与原 `modelSecret`。图片网关仅允许固定 Ark 图片端点，模型不能指定目标网址，账号容器不持有供应商密钥。回归：`node --test scripts/test-web-model-admin.mjs scripts/test-web-model-defaults.mjs`。

队列、停止、SSE 断线重放、上下文压缩和进程资源管理沿用原生 CardBush。前端直接复用 Electron 的 `MessageBubble`、消息投影与分组、执行过程折叠、`ToolExecutionBlock`、Markdown 和图片预览。`web/transcript.ts` 只做传输字段适配，`web/NativeTranscript.tsx` 通过 `ConversationHost` 接入受保护的个人文件和工具记录；网站主题由 `web/nativeTranscript.css` 提供。中间说明和工具执行归入同轮历史，最终答案只展示一次。工具结果先读取原生摘要，展开时按需读取完整记录；两个接口都先校验当前账号的会话归属。图片继续使用按账号隔离的浏览器缓存，切换会话复用图片 Blob，退出账号释放资源。

模型中转请求体上限与原生 Provider 对齐为 40,000,000 字节，包含历史图片的 Base64 和工具记录；这个传输限制与上下文 Token、最大输出设置分别计算。大请求的读取、JSON 校验和上传使用有界队列，收到供应商响应头后立即释放处理位，后续 SSE 回复继续并发。取消排队、账号停用和工具白名单检查仍生效。回归：`node --test scripts/test-web-model-request-size.mjs`，覆盖原先 16 MiB 边界、40 MB 上限、分块请求、并发流式回复和账号隔离。

图片任务复用火山插件 `ImageJobs` 的 SQLite 回执、幂等提交、并发限制及 `generation_wait`，不新建任务引擎，不自动重试已付费或结果未知的请求。broker 同时检查会话任务和图片任务，活动任务不会因空闲回收而被停止。渲染回归：`node --test scripts/test-web-transcript.mjs`；浏览器夹具：`node scripts/fixtures/web-transcript-browser.mjs`（127.0.0.1:5210，合成账号 alice/bob，任意测试密码，控制页 `/__test`，不调用模型）。`node scripts/build-web-release.mjs` 同时记录原生渲染依赖清单，便于审计前端发布，不重建 Agent Runtime。

已完成的生图回复在复制、时间旁显示“产物”，展开后逐张“下载”原图。入口复用 Electron 的 `TurnArtifactsMenu`，网页只提供下载操作。点击入口时，服务端按需从当前会话的真实图片工具回执生成清单，并校验正文引用的文件；拼图同时携带其源原图，包含前几轮生成并在本轮使用的图片。错误或不存在的正文图片路径不会混入下载清单，网络读取失败则允许重试。清单按个人生成文件路径去重，上传的参考图、视频、外部地址和其他账号文件不进入列表。清单校验只读取元数据，单张下载复用账号内的原图 Blob 缓存，不再次调用生图模型。回归：`node --test scripts/test-web-artifact-manifest.mjs scripts/test-web-artifacts.mjs scripts/test-web-transcript.mjs scripts/test-web-files-ui.mjs scripts/test-web-cache.mjs`。初始发布记录见 [NAS-20261011-artifacts.md](NAS-20261011-artifacts.md)。

“下载全部”通过服务器按 512 KiB 分段读取当前账号的生成图片，流式输出 ZIP64，浏览器下载管理器直接保存，不再受原先浏览器整包 128 MiB 限制。图片使用 STORE 避免重复压缩；慢速接收端施加背压，取消、退出或撤销身份后停止继续读取。元数据准备与传输共用两个全局工作槽，同账号只允许一路，其他请求有界排队。下载票据绑定账号及当前登录，仅保留短期清单和进度，不缓存图片或落地整包；单张下载和预览继续复用账号图片缓存。发布记录见 [NAS-20261016-stream-archive.md](NAS-20261016-stream-archive.md)。

下载回归：`node --test scripts/test-web-archives.mjs`。浏览器先运行 `node scripts/fixtures/web-progressive-browser.mjs dist-web`，再运行 `python scripts/test-web-download-browser.py`（需要 Python Playwright 和 Chrome）。大包验证分别追加 `--large-archive` 和 `--large`。夹具读取生产 CSP，验证同名多图、32 张 / 160 MiB ZIP 内容及 CRC、错误重试、单张和 IndexedDB 缓存、账号切换。

安全策略兼容修复发布记录见 [NAS-20261016-artifact-fetch.md](NAS-20261016-artifact-fetch.md)。

会话输入框上方提供“回到底部”浮动按钮，直接复用 Electron 的 `ScrollBottomButton` 和 `useScrollBottomPresence`。上翻阅读时显示，点击立即跳至最新消息并恢复底部跟随；底部稳定后隐藏。只调整本地滚动，不请求历史或工具详情，兼容窄屏和键盘操作。发布记录见 [NAS-20261016-scroll-bottom.md](NAS-20261016-scroll-bottom.md)。

图片插件还提供本地 `image_convert`：例如“把这张图转成 800 × 800 JPG”，可精确指定像素和 PNG/JPG/WebP 格式。默认等比缩放补白，保留整图与源文件；明确要求时支持居中裁剪和拉伸。转换结果接入相同的产物及下载入口，不调用生图模型。转换按账号串行放入独立受限进程，派发前重新校验插件授权。发布与回退细节见 [NAS-20261016-image-convert.md](NAS-20261016-image-convert.md)。

## 发布与回退

所有发布使用不可变镜像标签。更新活跃用户容器前先检查 `chat.jobs`，不要停止正在回复或排队的会话。停止空闲旧容器并重新创建时保留命名卷；broker 只使用自己标签下的容器。不要执行 `compose down -v` 或删除用户卷。

回退入口时停止 web 容器并重新启动原网站 frontend 与 backend 容器；新会话数据和命名卷继续保留。使用独立数据库迁移的部署，新版上线后的注册、密码和审批更改不自动回写旧库，回退前需核对这些变化。旧 SOP 数据库、素材及历史文件不删除、不伪装成 Agent 会话。

检查：`npm run test:web`（真实 CardBush Runtime + 两账号 Web ACL）、`npm run build:web:ui`。Linux 镜像内运行 `node --test scripts/test-web-plugin.mjs scripts/test-web.mjs scripts/test-web-files-ui.mjs`，测试目录需挂载可写 tmpfs；它验证原生插件安装、异步图片任务、撤权卸载和个人图片路径适配。部署后还需真实 PostgreSQL / Docker / 浏览器验收。

NAS 基础发布记录见 [NAS-20261009.md](NAS-20261009.md)；图片上传优化见 [NAS-20261010.md](NAS-20261010.md)；原生渲染更新见 [NAS-20261010-rendering.md](NAS-20261010-rendering.md)；全部产物下载与会话按需加载见 [NAS-20261016-progressive.md](NAS-20261016-progressive.md)。

## 浏览器缓存

登录经服务器验证后，浏览器按账号缓存会话列表、最近会话消息和个人图片。切换会话先显示内存或 IndexedDB 内容，再后台核对；刷新页面恢复最近打开的会话。正在生成的回复沿用原生事件缓冲与游标，在最近 8 个会话间切换时保留已显示进度。历史消息使用 memo 避免每个流式片段触发全量 Markdown 重绘；待完成任务也返回附件元数据，发送时立即显示附件。

IndexedDB 最多保留 40 个会话、160 张图片，总计 128 MiB，文本另限 12 MiB，7 天过期；单条会话缓存上限 2 MiB、单张图片上限 16 MiB，超限仍正常从服务端读取。内存数据缓存与未使用的图片 URL 池各限 24 MiB；正在显示的图片引用在卸载后回收。缓存不可用或磁盘配额不足时自动回退。不会缓存身份凭据、CSRF 或管理员权限。退出、账号切换和身份失效清理缓存及 Blob URL；跨标签页用身份围栏阻止旧请求回写。私有 API 和文件响应仍保持 `no-store`，图片由账号缓存管理，避免共享 HTTP 缓存串号。

缓存回归：`node --test scripts/test-web-cache.mjs scripts/test-web-files-ui.mjs`。手工慢网测试可运行 `node scripts/fixtures/web-cache-browser.mjs dist-web`（仅监听本机 5208）；该测试夹具可暂停读取响应，验证切换、刷新仍显示已缓存内容以及退出后清理。它不使用真实模型或生产账号。
