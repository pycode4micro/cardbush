# Windows 应用控制与发布验收

2026-09-28 的本机复现、三个组件的原因、历史证据边界及推荐分发方案见 [拦截调查报告](WINDOWS_BLOCKING_INVESTIGATION_2026-09-28.md)。

## 本次 10 项测试失败的原因

2026-09-21 的全量测试中，`processResourceGuard.test.mjs` 有 10 项依赖同一个临时编译的 `resource worker.exe`。Windows 在创建该进程时返回 Win32 错误 `4551`；Code Integrity 日志的事件 `3077`、`3033` 也记录了该文件未满足签名要求。它们是同一个测试夹具被阻止后造成的多项失败，不能算作通过，也不代表 10 个独立产品功能缺陷。

本机生成的 `CardBushProcessHost` 辅助程序同样未签名。这次日志明确阻止的是测试夹具，但未签名辅助程序仍是正式分发需要修复的风险。用户不应通过关闭智能应用控制、添加排除项或以管理员身份运行来解决。

## 代码中的处理

- 本地 `npm run gui` / `npm run dev` 遇到原生进程宿主无法创建进程时，会给出包含原始错误和 Code Integrity 日志位置的警告，继续构建界面。失败候选不会写入 `current.json`，现有清单保持原样；运行时仍要求可启动的进程保护组件，没有可用组件时命令不会执行。这只解决开发界面被构建错误连带阻断的问题，不代表 Windows 已允许该组件运行。
- 开发构建会单独记录失败候选的源码版本和二进制摘要，避免每次打开 GUI 都重新构建；任一 C# 源码、构建脚本或候选文件变化都会使记录失效。修复签名/组件后使用 `npm run gui:rebuild` 重新验证。普通 `npm run build`、CI 和发布验收仍严格要求启动检查通过；编译错误和协议不匹配在开发启动中也会失败。
- 进程保护层将明确的策略错误 `4551`、`1260` 标为 `process_application_control_blocked`，将签名错误 `577` 标为 `process_signature_rejected`，保留原始错误码和目标程序路径。普通权限不足、文件缺失、未知启动失败不会被误报为应用控制。此识别只针对辅助程序返回的创建进程错误；程序启动后加载 DLL 被拦截仍需结合 Windows Code Integrity 日志诊断。
- 启动失败仍然失败，不回退到无 Job Object 保护的执行，也不重试关闭安全功能。没有增加每次执行前的全盘验签，正常工具执行路径不增加外部进程或网络请求。
- `npm run package:win` 使用 `electron-builder.release.yml`，强制配置发布者签名，并将 EXE、DLL、Windows 原生 Node 模块纳入签名。签名后递归校验解包目录，安装程序生成后再校验安装包；有遗漏或无效签名即终止构建。
- GitHub Actions 的 `v*` 标签发布使用同一强制签名配置。普通分支和 PR 的安装包仅用于内部开发验证，不进入自动公开发布；`package:dir` 保留内部开发用途。

## 发布者需要完成的配置

准备受信任的 RSA 或 ECC 代码签名身份，使用 electron-builder 的 `win.signtoolOptions` 或 `win.azureSignOptions` 接入签名服务。当前 GitHub 标签发布预留仓库密钥 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD`，适用于支持该证书接入方式的签名身份；使用托管签名服务时应改为该服务的凭据配置。不要将私钥或密码提交到仓库。没有配置签名身份时，正式 Windows 安装包构建应失败。

检查使用构建机的 Windows 信任链以及受支持的 RSA / ECC 公钥算法。构建机本地信任的自签证书也可能显示 `Valid`，因此该检查不等于公众信任证明；发布证书必须另行确认来自受信任提供方。可信签名也不能覆盖企业管理员另外制定的限制策略。

已有 MSIX 流程生成的是 Microsoft Store 上传暂存包，继续保留不做本地签名的流程，不能将该包直接宣称为普通用户可安装的发行版。需要完成 Store 处理，并验收实际从 Store 获取的安装包。

### 当前实现与检查入口

- Computer Use 收到明确的应用控制/签名拒绝后，本轮停止重试；不能通过重新观察、换窗口或重新编译 DLL 恢复。修复安装或签名后可在新一轮再次检查。浏览器连接连续失败三次后暂停自动重连，暂停状态在扩展工作进程重启后仍保留；修复后手动重连。
- Windows 构建预编译 Computer Use 的操作库和提示浮层。发行包缺少这些库时明确报错，不再在用户机器上编译未签名的替代 DLL。EXE、DLL 和原生 Node 模块放在 ASAR 外部，纳入签名检查。
- `npm run release:check:win` 检查独立 EXE 的签名配置，缺少签名身份时尽早失败；配置存在不代表签名已验证。实际发行验收要求 Windows 验签通过、受支持的公钥算法、公有可信发布者和时间戳；自动检查拒绝自签证书，但构建机的信任链检查不能代替公有 CA 资格确认。
- `npm run release:check:msix` 检查本地 Store 身份文件格式。Partner Center 的 Publisher/Identity 信息不是独立 EXE 的签名证书或私钥，不能拿它们签 EXE。
- `npm run package:msix:stage` 生成供 Store 上传的未签名 MSIX，完成编译、清单、资源和包内隐私检查；不会把未进行的运行验证记作通过。输出报告保留 `signed: false`、`releaseReady: false` 和待完成步骤。默认 `npm run package:msix` 仍要求运行验证通过。提交前核对 Partner Center 身份和版本；正式签名及安装验收由 Store 流程完成。
- 打包后检查 ASAR 和外部资源中的私钥、签名身份配置及本地会话/凭据目录，发现即失败。该检查防止常见误打包，不等于完整隐私审计。签名材料只留在发布环境，用户各自的数据不应进入安装包。
- SSH 使用上游支持的 JavaScript/Node crypto 实现，不携带 `cpu-features` 和 `sshcrypto.node` 两个可选加速组件，避免额外本机编译与平台 ABI 问题。其他生产原生依赖仍通过 Electron rebuild 处理。

### 中国大陆个人的独立 EXE 申请入口

核实日期：2026-09-28。以下是申请方向，尚未取得证书或获得服务商批准。

- **免费开源项目：** [SignPath Foundation 申请](https://signpath.org/apply.html)。项目必须满足其[开源及构建审核条件](https://signpath.org/terms.html)。基金会以自己的身份签名，不要求个人身份证明；不是自动批准。第三方二进制有单独限制，不能假定其会代签包内全部上游 DLL，仍需逐项完成 Windows 发行验收。
- **个人付费证书：** [Certum Standard Code Signing in the Cloud](https://shop.certum.eu/standard-code-signing-in-the-cloud.html)。[官方材料说明](https://support.certum.eu/en/code-signing-required-documents/)明确支持个人，通常需要身份证明及本人名下的水电/电话等地址账单。大陆证件、地址证明和远程验证是否可接受，购买前通过[官方联系入口](https://www.certum.eu/en/contact/)确认。个人签名证书包含真实个人身份，不是匿名品牌证书。
- **非商业开源优惠：** [Certum Open Source Code Signing in the Cloud](https://shop.certum.eu/open-source-code-signing-on-simplysign.html)。需要公开项目和申请者关系证明，仅限个人，并限制商业分发；若未来收费，应先选择/更换适用的 Standard 产品。费用及可售状态以服务商最终确认为准。
- **微软 Artifact Signing：** [当前公有信任地区限制](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)中，个人仅限美国或加拿大，不能把中国大陆个人直接引导到该方案。

可向 Certum 客服询问（不要附私钥或密码）：

> I am an individual developer residing in mainland China, without a registered company. Can I obtain your Standard Code Signing in the Cloud certificate for independently distributed Windows EXE and DLL files? Which Chinese identity documents and proof of address are accepted? Is fully remote verification available, and what is the total current cost? Please also confirm which personal identity fields will be publicly visible in the certificate.

## 发布前验收

在保持智能应用控制开启的干净 Windows 环境验证正式分发产物的安装、首次启动、进程保护、终端执行、搜索和浏览器连接；检查 EXE 以及运行时加载的 DLL、原生模块。测试中的临时编译夹具也需要由测试发布流程签名后再执行，不能用跳过这 10 项或关闭策略冒充通过。

本次改动没有获取发布证书、给现有文件签名或证明所有 Windows 策略均会放行；它解决错误分类与发布漏签检查。签名交付和开启智能应用控制的端到端验收仍需完成。

独立插件必须对自己下载或携带的 Python、DLL、原生扩展负责。宿主安装包的签名不会自动覆盖后续安装的插件依赖。插件可以继续以源码开发；需要执行的本地二进制应由插件发布者提供可信、固定版本的依赖并进行对应验收。外层打包成 EXE 不会自动解决 `llvmlite.dll` 等内部文件的信任问题。

参考微软说明：[Smart App Control FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)、[Smart App Control 代码签名要求](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)、[应用和驱动程序控制](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control)。
