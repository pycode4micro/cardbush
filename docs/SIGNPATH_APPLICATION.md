# CardBush — SignPath Foundation 申请准备

核对日期：2026-09-28。状态：**用户报告申请表已显示提交成功，等待审核；未获批、未获得签名资格**。助手尚未独立核验提交回执或确认邮件。下文保留申请准备及当时的操作记录。

## 申请入口和已核实资料

- 申请页：<https://signpath.org/apply.html>
- 资格要求：<https://signpath.org/terms.html>
- 项目：CardBush
- 源码和项目说明：<https://github.com/pycode4micro/cardbush>
- 仓库所有者：`pycode4micro`
- 原创代码许可：[Apache-2.0](../LICENSE)，另见 [NOTICE](../NOTICE)。这不代表所有附带组件都采用该许可。
- 当前已公开的最新版本：[`v1.0.0-beta.3`](https://github.com/pycode4micro/cardbush/releases/tag/v1.0.0-beta.3)，有 Windows EXE、Linux AppImage、校验文件和成品启动报告。
- 当前源码的 `package.json` 版本：`1.0.0-beta.4`。不能把它写成已经公开发布的最新版本。
- 构建入口：<https://github.com/pycode4micro/cardbush/actions/workflows/desktop.yml>
- 申请人情况：位于中国大陆的个人维护者，没有公司；本人已更正并确认联系邮箱。联系资料单独存于 Git 忽略的本地文件，不在公开仓库中记录。
- Microsoft Store：维护者表示已有 MSIX 提交正在审核；这是另一个发行渠道，不代表独立 EXE 已有签名。

本次只核实公开项目资料和本地源码。没有向 SignPath 上传安装包、源码归档、系统日志、用户会话、凭据或私钥。

## 提交前必须如实说明的问题

### 附带技能的许可

SignPath 要求项目使用 OSI 认可的开源许可，且不包含专有组件。首次核查发现四项问题，现已在本地工作区按以下方式整理，详见 [技能许可记录](BUNDLED_SKILL_LICENSES.md)：

| 文件/目录 | 首次核查结果 | 本地处理结果 |
| --- | --- | --- |
| `assets/skills/pptx` | 旧入口、文档和脚本为专有许可 | 整套旧内容移出打包目录；独立编写基于开源工具的新技能，附 Apache-2.0 全文 |
| `assets/skills/xlsx` | 与上项相同 | 整套旧内容移出打包目录；独立编写新技能及不覆盖原件的重算包装器，附 Apache-2.0 全文 |
| `assets/skills/cardbush-docs/SKILL.md` | 标记 `license: Proprietary` | 核对项目文档整合提交后，将 CardBush 自有内容统一为项目 Apache-2.0，附许可全文 |
| `assets/skills/cardbush-agent-deploy/SKILL.md` | 标记 `license: Proprietary` | 核对 Agent/SSH 功能提交后，将 CardBush 自有内容统一为项目 Apache-2.0，附许可全文 |

`electron-builder.yml` 的 `extraResources` 会将当前 `assets/skills` 复制到后续发行包。旧专有目录只在被 Git 忽略且不参与打包的 `tmp` 备份中保留，未重新授权旧材料。这些整理尚未提交或推送，旧公开版本未改变；仍未完成其他技能和所有第三方依赖的完整许可审计。

### 签名范围与构建

申请优先覆盖 CardBush 自己维护、由公开源码构建的组件：

| 组件 | 源码/构建入口 | 用途 |
| --- | --- | --- |
| `CardBushBrowserHost.exe` | `native/chrome-connector/CardBushBrowserHost.cs`、`scripts/build-chrome-native-host.mjs` | Chrome Native Messaging 与 CardBush 之间的连接 |
| `CardBushProcessHost-*.exe` | `native/process-guard`、`scripts/build-process-resource-host.mjs` | 受管命令进程、资源限制与命令沙箱支持 |
| `CardBush-*.dll` | `packages/cardbush-apps-mcp/src/plugins/computerUseNativeCode.ts` 及相邻源码、`packages/cardbush-apps-mcp/scripts/build-computer-use.mjs` | Windows 桌面自动化和用户接管提示 |
| Windows 安装器及应用包 | `electron-builder.yml`、`.github/workflows/desktop.yml` | 安装 CardBush 桌面应用；Electron 和其他第三方原生组件的可签范围须由 SignPath 确认 |

第三方 Electron、Sharp/libvips、ripgrep 等二进制不能当成 CardBush 原创组件申请补签。保留供应商已有签名；对缺失签名的依赖寻求上游签名或合适的替代方案。安装器被签名不代表其中每个 DLL 已签名，也不代表当前所有 Windows 拦截均已解决。

现有 GitHub Actions 会构建和测试，但尚未接入 SignPath。接入前还需：

1. SignPath 接受项目，确定可签产物和所需账户/组织配置。
2. 确认 GitHub 与 SignPath 多因素认证、维护者/审查者/签名批准者角色；不能代替维护者声称这些已经完成。
3. 发布准确的 “Code signing policy” 和隐私说明。未获批前不写“签名已由 SignPath 提供”。
4. 按服务要求配置可追溯的 CI 构建、产品名称/版本元数据和人工签名批准。
5. 将构建、签名、运行验证分开，避免在辅助组件签名前因本机应用控制而无法完成构建流程；发布包只带当前所需的辅助组件。
6. 对签名后的完整包执行签名清单检查，并在保持 Windows 防护开启的环境验证安装、启动、电脑操控和浏览器连接。

这是接入待办，不能视为已实现的签名流水线。

## 英文申请说明（如实披露当前差距）

以下文本可用于申请表的项目介绍/补充说明，或申请前资格咨询。联系人姓名和邮箱应在官方表单填写，不写入公开仓库。表单的实际字段和必选声明仍需在页面中确认。

**Subject: CardBush — application / eligibility inquiry for free open-source code signing**

Hello SignPath Foundation team,

I maintain CardBush, a public desktop AI workspace for Windows and Linux. I am an individual maintainer based in mainland China and do not have a registered company. I would like to apply for your free open-source code-signing program and clarify the remaining eligibility requirements before requesting production signatures.

Repository and project documentation:
https://github.com/pycode4micro/cardbush

Published releases:
https://github.com/pycode4micro/cardbush/releases

Build workflow:
https://github.com/pycode4micro/cardbush/actions/workflows/desktop.yml

CardBush provides conversations with user-configured model providers, project/file tools, permission-controlled command execution, plugins, an integrated browser, and optional Windows desktop automation. Original CardBush code is licensed under Apache-2.0. Published beta releases include Windows EXE installers and Linux AppImages. The latest public release at the time of this inquiry is v1.0.0-beta.3; the working source version is v1.0.0-beta.4.

Our immediate signing needs are our own source-built Windows helpers: the Chrome Native Messaging host, the process/resource host, and desktop-automation DLLs. Windows Smart App Control has blocked some unsigned helpers. We want to distribute properly signed components while keeping users' operating-system protections enabled. We also seek guidance on the acceptable signing scope for the Electron-based application and its installer.

We have identified eligibility gaps and are not claiming that the currently published bundle already meets all requirements. In our local working tree, we replaced two proprietary third-party document skills (pptx and xlsx) with newly written CardBush skills that use external open-source tools, and aligned the licenses of two CardBush-specific skills with Apache-2.0. We did not relicense the old third-party material. These changes have not yet been committed or pushed, and previously published releases remain unchanged. The full remaining skill/dependency license and native-binary signing review is still pending.

We understand that your project subscription cannot be used to re-sign arbitrary third-party binaries. We would appreciate confirmation of the permitted scope, including how to handle Electron and other upstream native dependencies, and whether initial onboarding may proceed while the documented licensing gaps are being resolved.

Our existing GitHub Actions workflow builds and tests the application, but SignPath integration, the public code-signing policy, and the account/approval setup are not yet complete. We can provide the exact source/build references and follow your requirements for verified CI origin and release approval. We understand that acceptance is subject to your review.

Thank you.

## 本次操作状态

- 已核对公开仓库、公开版本、许可文件、打包包含关系和辅助组件构建入口。
- 已准备上述英文申请说明。
- 已请求在 Codex 中打开申请页；应用工具返回 `queued`，不能据此声称页面已显示或表单已填写。
- 浏览器控制连接连续两次超时，未取得可操作的表单会话。公开表单定义读取返回 HTTP 403，未绕过限制或尝试提交。
- 用户已提供联系资料并更正邮箱；未创建 SignPath 账户、未勾选资格/条款声明、未提交申请。
- 四项技能许可整理已落到本地工作区，未提交或推送；这不代表申请资格已全部通过。
- 后续重试已能识别用户在应用内浏览器打开的官方申请页及网址，但读取页面内容、DOM 和截图均超时；新标签页导航也未能完成。没有取得表单字段，也没有填写或提交联系资料。尚不能确定是页面加载还是浏览器控制连接导致。

用户随后手动填写表单，并报告页面显示已提交。该状态来自用户反馈；此前“未提交”记录描述的是助手尝试操作时的状态。尚未看到实际提交内容、回执或确认邮件，不能据此认定已通过资格审查。

后续应保留官网表单成功回执或确认邮件，以 SignPath 实际审批结果确认“已获批”。
