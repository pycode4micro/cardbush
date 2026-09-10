# OpenAI 托管连接器接入与独立验证

已作为实验性能力接入 CardBush 的插件设置与现有 MCP 客户端。CardBush 自行登录、保存和刷新凭据，不启动 Codex，也不读取 Codex 的配置、会话或登录文件。
独立验证脚本继续保留；它与桌面共用 OAuth 和结果校验代码，但仅在进程内存中保留凭据。

## 在 CardBush 中使用

1. 进入 **设置 → 插件 → OpenAI 账户**，点击“登录 OpenAI”，在浏览器完成授权。
2. 插件包含 `.app.json` 注册应用时，默认使用 OpenAI 托管连接。登录后，在应用旁点击“连接”，打开对应的 OpenAI 页面，再使用同一个 OpenAI 账户进入服务商 OAuth，例如登录 Google 并将日历权限授予 OpenAI。
3. 授权后返回当前插件页，CardBush 自动检查该应用的连接；也可点击“检查连接”。只有实际工具发现成功才显示“已连接”并收起授权步骤。“账户设置”内保留重新登录、退出、刷新全部应用及“在 ChatGPT 管理应用”入口。
4. 工具沿用 CardBush 既有权限配置。默认仍需询问，每个插件只暴露其注册应用对应的工具。

直连地址、OAuth 参数、独立服务绑定、逐工具权限和诊断详情位于默认折叠的“高级设置”，修改后才显示保存与重置操作。用户已有的直连配置继续生效；可在“高级设置 → 连接方式”中切换为“OpenAI 账户（实验性）”。页面布局调整不会迁移连接来源或更改权限。

排查连接时，`list_plugin_connections` 同时返回包内注册应用 ID、当前连接来源、宿主支持的来源及对应应用的 OpenAI 授权页面；指定插件时，运行状态和工具清单仅包含该插件的连接。支持 OpenAI 来源不代表账户已授权该应用，保存连接方式或打开网页也不代表运行时已经连通；返回值保留实际错误和待生效状态。

应用页面地址按[公开客户端的目录链接规则](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/connectors/src/lib.rs#L482)由注册 ID 和名称生成，统一限定为 OpenAI HTTPS 地址，不携带账户令牌。网页中的服务商 OAuth 由 OpenAI 维护；CardBush 不接收 Google 的授权码或令牌。此入口仍需用户在网页中完成同意授权，不能把打开网页宣称为授权完成。

桌面凭据由系统 safeStorage 加密，存入现有 `userData/mcp-oauth.bin` 的独立记录；不写入插件文件、`apps.json`、模型上下文或公共运行记录。刷新令牌供全部托管连接共享，并发刷新只执行一次。退出登录会停用旧连接并清除本机账户凭据；切换账号时不会把新凭据发送到旧账号的 MCP 会话。活动轮次内的目录更换延后生效，旧连接立即失效。

桌面的令牌请求和托管 MCP 请求均使用 [Electron `net.fetch`](https://www.electronjs.org/docs/latest/api/net)，沿用同一个默认 session 的系统/手动代理设置，并显式禁用浏览器 cookie 凭据。Node 独立验证脚本仍使用其启动环境的网络配置。

实际 401 最多刷新令牌一次；仍被拒绝时返回需要登录，用户从账户设置重新授权。共享账户登录会重建应用连接，不在旧会话上重放原工具调用。取消、超时或错误均通过状态和界面提示处理，不刷新整个应用。

连接状态区分等待运行中的任务结束与正在建立连接、读取工具目录；后者显示“连接中…”。界面通过只读状态查询跟随待生效配置，实际目录应用成功后自动显示“已连接”并收起授权步骤。MCP 工具发现会读取全部分页；分页失败、超时或游标重复时不发布部分目录。

OpenAI 返回的工具目录先按注册应用 ID 隔离，再交给 SDK 校验，避免其他应用的异常声明阻塞当前连接。可选 `outputSchema` 如果恰好是空对象 `{}`，按未声明输出约束处理，并在工具元数据中保留原始值和归一化标记；非空声明继续执行 SDK 的完整校验。这是托管协议边界的通用兼容，不修改插件包，也不按应用名称设置例外。

## 协议来源和边界

参考 OpenAI 公开源码的固定版本 `9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a`：

- [OAuth 登录流程](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/login/src/server.rs)
- [公开客户端注册信息](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/login/src/auth/manager.rs)
- [托管 MCP 地址和请求头](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/codex-mcp/src/mcp/mod.rs)

试验沿用该公开客户端的 OAuth client ID，登录页可能显示 Codex；托管服务请求也包含源码中的产品标识。
这不需要安装 Codex，但不等于 CardBush 已获得独立客户端注册或 OpenAI 对第三方宿主的正式支持。
公开源码展示了协议实现，不能据此承诺服务端接受独立客户端、长期保持接口稳定或开放所有应用。

## 运行

在项目根目录安装现有依赖后运行：

```powershell
node --use-env-proxy scripts/probe-openai-hosted-connectors.mjs --app-id connector_2128aebfecb84f64a069897515042a44 --tool-resource gmail.get_profile
```

1. 打开控制台 `authorizationUrl`，自行完成 OpenAI 登录和页面上的授权。
2. 浏览器回调后，脚本独立连接 OpenAI 托管 MCP 服务并读取工具目录。
3. 仅允许调用明确指定应用中、声明只读且无需必填参数的工具。此例只读取 Gmail 账户资料，不读取或发送邮件。
4. 终端只输出阶段、工具数量、调用是否成功及脱敏错误，不输出账户资料、工具结果正文或令牌。

不指定 `--tool-resource` 时只检查工具目录。该脚本不执行第三方应用的新增授权流程；目标应用需要在 OpenAI 账户中已有连接。

排查时可加 `--interactive`：登录后在当前进程内存中保留会话最多十五分钟，输入 `retry` 重新读取固定验证模块并再次执行同一只读检查，输入 `stop` 立即结束。
此模式同样不保存令牌到磁盘，后续重试不能改变启动时指定的应用和工具。

## 独立验证脚本的凭据和生命周期

- 随机 `state` 和 PKCE S256；回调只监听本机 IPv4。
- 使用公开客户端回调端口 1455，已占用时尝试 1457；不会终止占用端口的其他程序。
- 回调验证来源、Host、路径、状态和重复提交；十分钟超时，Ctrl+C 也可结束本次验证。
- OAuth 令牌及授权码只在进程内存中使用，不写入磁盘或日志；进程结束后不再保留。
- 本次流程申请源码中的连接器读取和调用 scope，并包含 `offline_access`，但不会保存或使用返回的刷新令牌。令牌不落盘不代表 OpenAI 服务端授权记录自动撤销。
- 令牌兑换和 MCP 请求只发往代码中固定的 OpenAI HTTPS 地址，不跟随重定向。
- 运行时沿用用户已有网络代理配置；本地测试的回调流量固定走本机。

## 验证状态

`node --test scripts/test-openai-hosted-probe.mjs` 通过 17 项回归，覆盖 OAuth 状态/PKCE、并发回调、取消/超时、端口冲突、异常响应、工具身份与只读约束以及错误脱敏。诊断也区分服务端工具结果与 SDK 的输出结构校验失败，并只记录结构，不记录账户资料值。
这些测试使用本地回调和模拟 MCP 响应，不能替代真实账户验收。

2026-09-09 的未认证 MCP 请求返回 HTTP 451，响应消息为 `no_biscuit_no_service`。
这是未带账户令牌的结果，不能推断已登录请求也会失败，也不能仅凭该状态码认定是地域限制。
2026-09-09 真实独立登录和 Gmail 只读调用均已通过，验证进程随后正常退出并释放内存中的凭据。使用用户新完成的 OpenAI OAuth 登录，全程未启动 Codex，也未读取它的凭据文件。

```json
{
  "stage": "probe_completed",
  "transport": "direct_https_mcp",
  "usesCodexProcess": false,
  "usesCodexCredentialFiles": false,
  "catalogReady": true,
  "appCount": 6,
  "targetToolCount": 21,
  "readonlyCallSucceeded": true,
  "outputNormalization": "validated_declared_result_envelope"
}
```

目录包含 6 个应用标识，Gmail 匹配到 21 个工具；仅实际调用了 `gmail.get_profile`，未读取邮件、执行写操作或调用其他应用。因此这次通过不能代表所有应用、所有工具均已验收。

首次调用暴露了服务端定义与返回结构不一致：`outputSchema` 声明 `{ result: Profile }`，实际 `structuredContent` 是 `Profile`。服务端工具返回 `isError: false`，本地 SDK 因缺少外层 `result` 抛出 `ProtocolError(-32602)`。

当时的验证采用了补齐 `result` 外层再校验的适配。2026-09-10 的上下文交付优化撤销了这一返回重写：普通 MCP 与 OpenAI 托管 MCP 均保持原始结果；SDK 校验失败时保留收到的完整 `rawResult`，同时报告独立的客户端解析错误，不补包裹、不把 `null` 改为空对象、不自动重复调用。验证脚本也不再合成返回结构。因此上述历史成功不能视为当前版本已通过同一工具的真实 API 验收；后续需重新确认服务端返回和模型处理真实错误的能力。

此结果验证了当前账户和服务条件下独立登录、直连 OpenAI 托管 MCP 的可行性。后续桌面接入覆盖了加密存储、刷新与退出、插件绑定、工具权限及界面流程；使用 `npm run test:openai-hosted` 运行隔离回归，不会登录真实账户或访问真实应用数据。真实账号验证来自上述独立脚本，桌面完整登录流程使用模拟服务验收，不能将其宣称为全部插件的真实端到端验收。公开客户端注册信息和服务端接口的支持边界仍按上文说明。

2026-09-10 使用 CardBush 自己保存的登录状态，通过实际插件连接解析器、`McpClientManager` 和 Electron 网络请求验证 Canva 工具发现，结果为 `applicationState: applied`、`health: ready`、35 个工具。首次读取发现 Canva 的空 `outputSchema` 导致 SDK 拒绝整个目录；上述通用兼容修复后加载成功。本次只读取工具目录，没有调用 Canva 内容工具，也没有重新登录或修改授权。回归同时覆盖空声明的原始值保留、非空非法声明拒绝、跨应用隔离、后续分页工具可调用以及等待 → 连接中 → 已连接的界面状态变化。
