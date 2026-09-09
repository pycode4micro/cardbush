# OpenAI 托管连接器接入与独立验证

已作为实验性能力接入 CardBush 的插件设置与现有 MCP 客户端。CardBush 自行登录、保存和刷新凭据，不启动 Codex，也不读取 Codex 的配置、会话或登录文件。
独立验证脚本继续保留；它与桌面共用 OAuth 和结果校验代码，但仅在进程内存中保留凭据。

## 在 CardBush 中使用

1. 进入 **设置 → 插件 → OpenAI 账户**，点击“登录 OpenAI”，在浏览器完成授权。
2. 插件包含 `.app.json` 注册应用时，默认使用 OpenAI 托管连接。用户已经填写的直连地址、请求头、OAuth 参数或独立服务绑定继续生效；可在插件详情的“连接方式”中切换为“OpenAI 账户（实验性）”。
3. 目标应用尚未授权时，点击“在 ChatGPT 管理应用”，在 ChatGPT 完成该应用连接，然后回 CardBush 点击“刷新应用连接”。账户已登录与具体应用工具可用是两个状态。
4. 工具沿用 CardBush 既有权限配置。默认仍需询问，每个插件只暴露其注册应用对应的工具。

桌面凭据由系统 safeStorage 加密，存入现有 `userData/mcp-oauth.bin` 的独立记录；不写入插件文件、`apps.json`、模型上下文或公共运行记录。刷新令牌供全部托管连接共享，并发刷新只执行一次。退出登录会停用旧连接并清除本机账户凭据；切换账号时不会把新凭据发送到旧账号的 MCP 会话。活动轮次内的目录更换延后生效，旧连接立即失效。

桌面的令牌请求和托管 MCP 请求均使用 [Electron `net.fetch`](https://www.electronjs.org/docs/latest/api/net)，沿用同一个默认 session 的系统/手动代理设置，并显式禁用浏览器 cookie 凭据。Node 独立验证脚本仍使用其启动环境的网络配置。

实际 401 最多刷新令牌一次；仍被拒绝时返回需要登录，用户从账户设置重新授权。共享账户登录会重建应用连接，不在旧会话上重放原工具调用。取消、超时或错误均通过状态和界面提示处理，不刷新整个应用。

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

适配只用于 OpenAI 托管传输，桌面与验证脚本共用：声明恰好包含一个必填 `result` 字段、原值未包裹且不符合外层定义时，尝试 `{ result: 原值 }`，并验证完整的原始 Schema（包含 `$defs`、类型、格式和额外字段限制）。候选值通过后再交给 SDK 正常校验；其余异常仍然报错。已有合法返回不变，工具错误不包装，原始内容块保留，归一化有明确来源标记，也不按 Gmail 名称写特例。

此结果验证了当前账户和服务条件下独立登录、直连 OpenAI 托管 MCP 的可行性。后续桌面接入覆盖了加密存储、刷新与退出、插件绑定、工具权限及界面流程；使用 `npm run test:openai-hosted` 运行隔离回归，不会登录真实账户或访问真实应用数据。真实账号验证来自上述独立脚本，桌面完整登录流程使用模拟服务验收，不能将其宣称为全部插件的真实端到端验收。公开客户端注册信息和服务端接口的支持边界仍按上文说明。
