# ChatGPT 套餐接入（SIWC）

[English](SIWC_INTEGRATION.md) · [简体中文](SIWC_INTEGRATION.zh-CN.md)

桌面与本地 CLI 模型支持官方 Sign in with ChatGPT。在**设置 → 模型 → 添加模型**选择 **ChatGPT · SIWC**，点击 **Continue with ChatGPT**，在系统浏览器授权后从账号目录选择模型。账号中心支持添加账号、重新登录、查看用量和退出。

这与 OpenAI connector/MCP 账号独立：连接器登录不等于推理授权；API key 模型继续使用原适配器及凭据。

## 所有权与数据流

- `bush-protocol/siwc.ts` 定义公开账号快照和 `{ kind: 'chatgpt', accountId }` 引用。模型配置、renderer 存储、Runtime 事件及检查点不携带 OAuth token。
- `electron/siwcOAuth.mts` 管理 loopback 授权、PKCE、state/nonce、动态客户端注册、签名 OIDC 身份验证、换取及撤销 token。端点固定到 OpenAI，发现提供已验证的 JWKS/撤销地址。监听仅绑定 `127.0.0.1`，10 分钟过期。
- `electron/siwcAccounts.mts` 在桌面加密凭据库独立键下保存注册。host ID 在退出后保留；首次换取失败也保留已发 client ID。身份基于注册与已验证 subject，不按邮箱合并。同身份重注册保留模型引用的 account ID。
- 每账号串行刷新，新 token 原子保存后才使用。单个 turn 取消不取消其他 turn 共用的刷新。退出立即禁止新访问、使该账号活动流失效、等待轮换完成、撤销最新可续期会话并移除本地 token；无法确认远端撤销时明确报告。
- `ProductModelConfigStore` 与 Product Host 为普通会话、固定/继承模型子 Agent、Shadow 和自动化解析同一不可变绑定。私有 desktop/worker 桥为每次 HTTP 交换获取新 access token，刷新不改变绑定修订或上下文前缀。
- `electron/localModelAccess.mts` 把 CLI 接到同一桌面 `SiwcAccounts`。App 持有注册、凭据库和刷新；CLI 只经鉴权本地 IPC 取短期 access token。Windows 使用仅当前用户与 SYSTEM 可访问的命名管道/目录；Unix 使用私有目录/socket。描述文件仅含轮换的 IPC secret，不含 OAuth token。该 broker 只提供账号访问、取消及失效事件，无 HTTP 端点。
- 模型固定绑定所选账号。权限缺失、到期、退出或额度耗尽均不自动改用其他账号/API key。

## 本地 CLI

在 App 登录并配置 ChatGPT 模型后，保持 App 运行，在工作目录执行 `cardbush`。CLI 读取同一模型配置并自动向桌面请求访问，不需服务 token、复制 OAuth token 或重复注册。`/model` 切换已配置模型，`CARDBUSH_CLI_PROFILE_DIR` 指定其他桌面配置目录。

CLI 的会话和工具仍在自己的本地 Runtime 执行。API key 模型无需 App；账号模型在 App 关闭或退出时使活动请求失效。App 重启轮换 IPC secret，下次请求自动重连。App 不可用时给出可操作错误，不无限重试，也不将本机称作远程 Agent。更新此桥后重启 App 与 CLI。

## Responses 投影

沿用现有适配器解析流、推理、用量、本地工具及回放数据。SIWC 模式：

- 只请求 `https://api.openai.com/v1/responses`，`stream:true`、`store:false`，每轮发送完整历史。
- system 转为 developer 消息，函数声明通过 `additional_tools` 输入项提交；MCP 发现仍为函数，不请求原生 `tool_search`。
- 不发送 `previous_response_id/max_output_tokens/temperature/top_p` 及不受支持的托管工具/参数。
- 使用本地 token 估计和现有请求体预算，不探测不支持的计数端点。
- 普通 API key Responses、Chat Completions、Messages 不变；鉴权/额度失败不切换协议。
- 无状态工具轮次保留加密推理。额度耗尽停止自动重试，暂时用量服务错误沿用有限重试；HTTP 与流中错误保留原码及 request ID。

模型发现使用所选账号 token 调用公开 `/v1/models`，保留返回顺序，显示 `display_name`、提交真实 `slug`；仅展示 `visibility:list`。切换账号丢弃旧目录响应。目录可读不证明具备推理资格，实际推理成功才是验证。

## 当前边界与验证

注册及 refresh token 留在本机桌面凭据库，不复制到 CLI/远程 worker，也不读取 Codex/ChatGPT 私有凭据文件。只对明确构造的本机 CLI 宿主授权，环境变量不能冒充。远程 worker 需自行配置支持的凭据；引用本地 SIWC 账号明确报错，注册连接不会导入本地登录。

真实套餐请求需符合条件的账号完成官方授权。自动测试使用隔离账号、签名 JWT、真实 loopback 回调和模拟 OpenAI HTTP，不证明生产账号资格，也不消耗用户套餐。

先运行 `npm run build:agent`（包括原生 IPC 权限助手及桌面 TypeScript）：

```sh
node --test --test-timeout=45000 scripts/test-local-model-access.mjs scripts/test-siwc-accounts.mjs scripts/test-siwc-model-host.mjs packages/bush-provider-openai/test/siwc.test.mjs
node scripts/run-siwc-ui-test.mjs
```

覆盖身份隔离、state/nonce、重复注册、GUI/CLI 共享轮换、保存期间取消、刷新时退出、撤销失败、桌面重连、远程隔离、过期目录响应、模型持久化、子任务/自动化绑定、工具回放及缓存前缀。隔离 CLI 通过模拟 Provider HTTP 执行真实绑定、IPC、本地文件工具和交付；原连接器/Responses/注册表/工具发现测试仍适用。

以下为原接入核对所用官方资料（2026-10-02）；服务政策以官方当前说明为准：

- [注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [账号与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
