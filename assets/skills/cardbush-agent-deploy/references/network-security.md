# 网络接入与安全

根据用户选择和服务器现有配置，只实施本次部署所需的改动。默认保留 SSH 管理通道，服务绑定 `127.0.0.1`；接入方式不明确时先完成仅回环监听的部署准备，不自行开放公网。

## SSH 隧道

优先使用 CardBush 连接管理器托管：在 Agent 的连接设置中选择「SSH 隧道（自动连接）」，关联已保存并核验主机指纹的 SSH 连接，填写服务器 Agent 端口（默认 `4780`）和本机转发地址（例如 `http://127.0.0.1:14780`）。连接管理器负责建立、重连和应用重启后的恢复；不要用 Agent 的临时终端维持长期隧道。

仅在临时诊断或用户明确要求手动隧道时，在客户端终端建立本地转发。示例中的 `HOST_ALIAS` 必须是实际可用的 SSH 配置别名；CardBush 的连接显示名称未必是系统 SSH 别名：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:14780:127.0.0.1:4780 HOST_ALIAS
```

手动隧道使用 HTTP 直连方式填写 `http://127.0.0.1:14780` 和该实例令牌，不同时启用同端口的自动隧道。本地端口明确绑定回环地址；不要使用 `-g` 或绑定 `0.0.0.0`。隧道断开不停止服务器任务。此方式无需 Nginx、域名或 Agent 公网端口。

## HTTPS 代理

已有 Nginx、Caddy 或受管理网关时优先复用，为 Agent 增加独立域名及路由。使用客户端信任且匹配域名的证书，配置证书续期；没有证书时先用隧道，不以跳过证书校验代替。Nginx 的证书及私钥配置见 [官方 HTTPS 文档](https://nginx.org/en/docs/http/configuring_https_servers.html)。

Nginx 示例放在现有 `http` 上下文包含的独立配置文件中。域名、证书路径、端口必须替换为实际值；证书需先准备好。本例仅对该 Agent 域名生效，不替换全局配置或其他站点：

```nginx
# 只记录诊断所需字段，不记录查询串、请求体或 Authorization。
log_format cardbush_agent '$remote_addr [$time_local] $request_method $uri $status';

server {
    listen 443 ssl;
    server_name agent.example.com;
    ssl_certificate /etc/letsencrypt/live/agent.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agent.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    access_log /var/log/nginx/cardbush-agent-access.log cardbush_agent;
    client_max_body_size 2m;

    location /api/agent/v1/ {
        proxy_pass http://127.0.0.1:4780;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_set_header Authorization $http_authorization;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_next_upstream off;
    }

    location = /health {
        proxy_pass http://127.0.0.1:4780;
        proxy_set_header Authorization $http_authorization;
        proxy_cache off;
    }

    location / { return 404; }
}
```

保留 `Authorization`、`Accept`、`Last-Event-ID`、`X-CardBush-Agent-ID` 以及 `Origin` 原值；不固定注入正确令牌，不添加浏览器 CORS 放行。关闭响应缓冲与缓存，允许 SSE 和 NDJSON 持续输出，并避免代理自动重试产生副作用的请求。信息与事件接口使用 GET，业务调用使用 POST。代理参数语义参见 [Nginx 代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。

先执行 `nginx -t`，通过后才 reload；语法失败就恢复本次新增配置，不反复重启已有代理。若要启用端口 80，仅用于已经安排的证书验证或 HTTPS 跳转，不通过明文入口承接带令牌的 API 请求。证书续期也要验证成功后 reload。

多个 Agent 使用不同后端端口和独立域名。不要把不同实例轮询挂到同一个上游地址：它们各自拥有状态和 ID，不是可互换的无状态副本。

## 防火墙、账号和凭据

- 保留已有防火墙体系，不同时叠加 UFW、firewalld、手写 nftables 等多套规则。检查 IPv4、IPv6 和云安全组；只开放必要的 HTTPS 与已确定的 SSH 管理入口，后端 4780 不向公网开放。
- 先确认实际 SSH 端口及管理来源，并保留现有连接。在改变入站规则后，用第二条连接验证仍可登录，再关闭原连接。不要清空已有规则或为部署修改默认策略。
- 服务账号无特权且只能访问所需项目。互不信任的实例应分开系统账号或容器，不共享令牌、数据和可写代码目录。
- 令牌是实例所有者凭据。用系统生成的随机值，不放进 URL、代理配置、访问日志、终端参数或聊天。泄露后通过受保护文件或配置替换令牌并重启对应实例、更新客户端；当前不支持无停机双令牌轮换。
- SSH 优先使用密钥认证。只有确认新的登录路径可用且更改登录策略在授权范围内时，才调整密码或 root 登录配置；不要为本 skill 强制改动全机 SSH 策略。

## Fail2ban：按需启用

Fail2ban 从失败日志中识别来源并触发封禁，不能替代强认证、TLS 或权限隔离。仅安装软件并不会自动保护 CardBush 的 Bearer 接口。参见 [Fail2ban 官方说明](https://github.com/fail2ban/fail2ban#readme)。

- SSH 暴露公网且需要减少重复认证尝试时，可采用发行版的 `sshd` 过滤器。核对实际端口、日志后端（journal 或文件）及封禁动作，使用独立 `jail.d/*.local` 配置，不覆盖发行版主配置。
- 检查可信管理来源的排除规则，不能把所有网段都列入白名单。启用前用 `fail2ban-client -t` 检查配置；用真实失败日志和成功登录日志验证过滤器的命中与不命中，再检查 `fail2ban-client status sshd`。准备好指定 IP 的解封方式和备用管理入口。
- 针对 CardBush HTTP 的自定义封禁是可选项：需要专属日志、精确匹配本接口鉴权失败的规则，以及误封恢复验证。不要把所有 `4xx`、普通断线或长轮询超时都视为攻击；错误令牌或带 Origin 的合法排查也可能出现 `401`。
- 若前置 CDN 或多级代理，日志地址和防火墙可见地址可能不同。只信任已知代理提供的真实 IP，不信任任意客户端的 `X-Forwarded-For`。不能封禁共享代理、NAT 或回环地址；必要时在实际能识别来源的网关执行封禁，否则不启用该规则。
- 启用前验证日志轮转、封禁动作和解封恢复。没有完成这些验证时，将 HTTP 封禁列为尚未启用，不生成一个看似生效的通用正则。

如另加限流，先测多个会话同时轮询、发消息和重连的正常流量，避免把合法多 Agent 并发误判为攻击。网络防护不能识别所有恶意任务内容，任务执行仍受实例权限和已有审批机制约束。
