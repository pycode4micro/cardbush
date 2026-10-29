# MCP 官方 Conformance

[English](MCP_CONFORMANCE.en.md) · [简体中文](MCP_CONFORMANCE.md)

CardBush 运行官方客户端测试套件，驱动 `McpClientManager`、`McpOAuthCoordinator` 和 Runtime 工具注册表的生产实现。18 项核心场景保持官方原版；扩展运行的旧协议场景包含一项明确记录的本地夹具修正。没有另写 MCP 客户端，也没有修改官方判分规则。

测试依赖固定为 `@modelcontextprotocol/conformance@0.1.16`。覆盖范围依据 [官方 v0.1.16 源码](https://github.com/modelcontextprotocol/conformance/tree/v0.1.16)，对应提交 `21a9a2febd7100d7c17ac1021ee7f2ed9f66a1e0`。升级套件时需要重新核对场景，运行器会拒绝未经核对的版本。

## 运行

```sh
# 构建 Runtime，然后运行官方 18 项核心客户端场景
npm run test:mcp-conformance

# 核心场景 + 两项旧协议兼容场景（含记录在报告中的 issuer 夹具修正）
npm run test:mcp-conformance:all

# 原封不动运行上游夹具，用于复现或对比；0.1.16 的旧 issuer 用例仍失败
npm run test:mcp-conformance:all -- --fixture-mode upstream

# 指定单项，或只运行旧协议兼容场景
npm run test:mcp-conformance -- --scenario auth/scope-step-up
npm run test:mcp-conformance -- --suite backcompat

# 已完成构建时，可直接运行，避免重复构建
node scripts/run-mcp-conformance.mjs --output tmp/mcp-conformance/my-run
```

输出目录必须是新目录，防止混入旧结果。默认保存到 `tmp/mcp-conformance/<时间戳>/`，包括汇总 `report.json`、每个场景的官方检查记录、客户端输出和运行日志。报告记录源文件与构建文件哈希、套件版本、Node 版本、运行平台，以及 `fixtureMode`、`fixtureCorrections` 和具体场景的补丁加载状态。该目录不进入 Git。

默认 18 项与官方 `coreScenariosList` 对应；`all` 表示本接入覆盖的 20 项核心及旧协议场景，不包含三个 draft 场景与三个 extension 场景。未运行场景明确记为排除项，不计为通过。

测试仅连接临时 loopback 服务，使用独立内存凭证存储，不读取用户账户、浏览器配对或模型配置，不调用模型。驱动只模拟用户在官方本地授权页面确认授权，授权码仍经过产品实际的回调、state、issuer 和令牌校验。

## 判分与 CI

- 场景通过必须同时满足：官方进程成功退出、有成功检查、无失败或警告、CardBush 驱动确认完成。进程提前退出或超时不能当作通过。
- `scope-retry-limit` 会故意拒绝全部令牌；驱动还要求最终状态确实为 `auth_required`，避免把任意客户端崩溃计作成功。
- 场景串行运行，减少 SSE 重连计时用例受并发负载干扰。客户端、官方场景和外围运行器都有超时限制。
- Desktop CI 在 Windows、Linux 构建后执行 20 项核心及旧协议场景，并上传测试报告；旧 issuer 用例使用下述已记录的夹具修正。没有隐藏失败基线或预期失败豁免，任何失败仍返回非零退出码。

## 2026-10-26 实测

Windows、Node `v24.20.0`、产品 MCP SDK `2.3.1`。测试使用产品默认协议协商，包括向已发布协议回退。

| 范围 | 产品修复前 | 产品修复后、原版夹具 | 同时修正旧 issuer 夹具 |
| --- | --- | --- | --- |
| 官方核心场景 | 15 / 18 | 18 / 18 | 18 / 18 |
| 旧协议兼容场景 | 1 / 2 | 1 / 2 | 2 / 2 |
| 合计 | 16 / 20 | 19 / 20 | 20 / 20 |

### 已修复的产品问题

1. **OAuth 授权要求在后台发现与交互登录之间丢失。** HTTP transport 收到的 `WWW-Authenticate` scope 和资源元数据地址没有传入新建的交互登录流程，导致首次授权申请错误 scope，或权限升级后再次提交旧权限。现在按服务、端点及 OAuth 配置保存待处理挑战，交互登录复用它；升级权限合并已有 scope，并重新请求用户同意，不依靠刷新令牌获得新增权限。授权成功后消费挑战，退出登录时清理。通过 `scope-from-www-authenticate`、`scope-step-up` 和重试上限检查。
2. **接受表单时没有应用 schema 默认值。** 现启用 SDK 的表单默认值处理。仅填充接受结果中遗漏的字段，保留用户明确填写的 `false`、`0`、空字符串；拒绝或取消不产生默认内容。通过 `elicitation-sep1034-client-defaults`；产品回归同时覆盖现代和旧协议。

夹具修正后的 MCP 客户端回归 **142 项通过、0 项失败、1 项跳过**，跳过项是 Windows 不适用的 POSIX 环境变量大小写测试。前一轮 Runtime 和 Electron/CLI 的 TypeScript 构建通过；上面的默认 npm 测试入口已实际跑通并返回成功。本轮仅修改测试接入、夹具和回归用例，产品授权实现未改动。

本地原版证据目录：`tmp/mcp-conformance/baseline/`、`fix-verification/`、`final-all/`、`final-core/`；前一轮回归日志为 `tmp/mcp-conformance/mcp-regression.log`，夹具修正后的回归日志为 `tmp/mcp-conformance/issuer-mcp-regression.log`。

### 旧协议夹具修正

`auth/2025-03-26-oauth-metadata-backcompat` 的夹具从根路径 `/.well-known/oauth-authorization-server` 返回元数据，但声明的 issuer 带 `/oauth` 路径。当前 SDK 根据发现地址期待根 issuer，报 `IssuerMismatchError`。直接使用官方 SDK、去掉 CardBush 包装层后仍复现同一错误。

相关夹具在官方 [`march-spec-backcompat.ts`](https://github.com/modelcontextprotocol/conformance/blob/v0.1.16/src/scenarios/client/auth/march-spec-backcompat.ts) 和 [`helpers/createAuthServer.ts`](https://github.com/modelcontextprotocol/conformance/blob/v0.1.16/src/scenarios/client/auth/helpers/createAuthServer.ts)。[RFC 8414 §3.3](https://www.rfc-editor.org/rfc/rfc8414#section-3.3) 要求 issuer 与构造发现地址时使用的值完全一致。

本地源补丁为 [`patches/mcp-conformance/0.1.16-legacy-issuer.patch`](../patches/mcp-conformance/0.1.16-legacy-issuer.patch)：将 issuer 路径与接口路由前缀分开，旧用例使用根 issuer，保留 `/oauth/authorize`、`/oauth/token`、`/oauth/register`。其他场景默认行为保持一致。

官方 npm 包只发布了压缩后的代码，因此通过 Node 模块加载钩子将同等修正应用于该用例的测试进程。补丁只匹配固定版本和精确 SHA-256，文件变化或重复打补丁会立即失败；保留原始模块地址及依赖解析，不修改 `node_modules` 文件，不进入产品或客户端进程。原版运行通过 `--fixture-mode upstream` 选择。报告明确标记这是本地修正后的结果，不将其冒充为未经修改的上游通过结果。

新增 `oauthIssuer.test.mjs` 回归验证：错误的 issuer 路径仍在客户端注册和用户授权之前被拒绝。产品的 issuer、state、PKCE 校验保持开启。原版用例复跑仍失败，确认没有靠放宽产品校验解决问题。

SDK 独立复现记录：`tmp/mcp-conformance/sdk-issuer-probe.log`。夹具修正后的完整报告为 `tmp/mcp-conformance/issuer-corrected-all/report.json`；原版对照为 `tmp/mcp-conformance/issuer-upstream-confirmed/report.json`。本地补丁尚未提交上游，未来升级官方套件时须核对并移除已被上游修复的补丁。

## 能说明什么

这组测试验证 MCP 客户端初始化、工具调用、表单默认值、SSE 重连，以及 OAuth 发现、scope、令牌端点认证和预注册流程，能作为协议回归门禁。

它不证明模型任务完成率，也不覆盖 CardBush 自己的浏览器扩展 WebSocket 配对、系统授权界面、MSIX 启动、会话压缩、并发 Agent 或 MCP 服务端角色。三个 draft 和三个 extension 场景尚未接入；现代协议的其他行为继续由产品回归测试覆盖。本次实测在 Windows，Linux 的 CI 入口已配置，不能视为已经在 Linux 跑过。
