# Windows 应用控制与发布验收

## 本次 10 项测试失败的原因

2026-09-21 的全量测试中，`processResourceGuard.test.mjs` 有 10 项依赖同一个临时编译的 `resource worker.exe`。Windows 在创建该进程时返回 Win32 错误 `4551`；Code Integrity 日志的事件 `3077`、`3033` 也记录了该文件未满足签名要求。它们是同一个测试夹具被阻止后造成的多项失败，不能算作通过，也不代表 10 个独立产品功能缺陷。

本机生成的 `CardBushProcessHost` 辅助程序同样未签名。这次日志明确阻止的是测试夹具，但未签名辅助程序仍是正式分发需要修复的风险。用户不应通过关闭智能应用控制、添加排除项或以管理员身份运行来解决。

## 代码中的处理

- 进程保护层将明确的策略错误 `4551`、`1260` 标为 `process_application_control_blocked`，将签名错误 `577` 标为 `process_signature_rejected`，保留原始错误码和目标程序路径。普通权限不足、文件缺失、未知启动失败不会被误报为应用控制。此识别只针对辅助程序返回的创建进程错误；程序启动后加载 DLL 被拦截仍需结合 Windows Code Integrity 日志诊断。
- 启动失败仍然失败，不回退到无 Job Object 保护的执行，也不重试关闭安全功能。没有增加每次执行前的全盘验签，正常工具执行路径不增加外部进程或网络请求。
- `npm run package:win` 使用 `electron-builder.release.yml`，强制配置发布者签名，并将 EXE、DLL、Windows 原生 Node 模块纳入签名。签名后递归校验解包目录，安装程序生成后再校验安装包；有遗漏或无效签名即终止构建。
- GitHub Actions 的 `v*` 标签发布使用同一强制签名配置。普通分支和 PR 的安装包仅用于内部开发验证，不进入自动公开发布；`package:dir` 保留内部开发用途。

## 发布者需要完成的配置

准备受信任的 RSA 代码签名身份，使用 electron-builder 的 `win.signtoolOptions` 或 `win.azureSignOptions` 接入签名服务。当前 GitHub 标签发布预留仓库密钥 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD`，适用于支持该证书接入方式的签名身份；使用托管签名服务时应改为该服务的凭据配置。不要将私钥或密码提交到仓库。没有配置签名身份时，正式 Windows 安装包构建应失败。

检查使用构建机的 Windows 信任链以及 RSA 公钥算法。构建机本地信任的自签证书也可能显示 `Valid`，因此该检查不等于公众信任证明；发布证书必须另行确认来自受信任提供方。可信签名也不能覆盖企业管理员另外制定的限制策略。

已有 MSIX 流程生成的是 Microsoft Store 上传暂存包，继续保留不做本地签名的流程，不能将该包直接宣称为普通用户可安装的发行版。需要完成 Store 处理，并验收实际从 Store 获取的安装包。

## 发布前验收

在保持智能应用控制开启的干净 Windows 环境验证正式分发产物的安装、首次启动、进程保护、终端执行、搜索和浏览器连接；检查 EXE 以及运行时加载的 DLL、原生模块。测试中的临时编译夹具也需要由测试发布流程签名后再执行，不能用跳过这 10 项或关闭策略冒充通过。

本次改动没有获取发布证书、给现有文件签名或证明所有 Windows 策略均会放行；它解决错误分类与发布漏签检查。签名交付和开启智能应用控制的端到端验收仍需完成。

独立插件必须对自己下载或携带的 Python、DLL、原生扩展负责。宿主安装包的签名不会自动覆盖后续安装的插件依赖。插件可以继续以源码开发；需要执行的本地二进制应由插件发布者提供可信、固定版本的依赖并进行对应验收。外层打包成 EXE 不会自动解决 `llvmlite.dll` 等内部文件的信任问题。

参考微软说明：[Smart App Control FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)、[Smart App Control 代码签名要求](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)、[应用和驱动程序控制](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control)。
