# 依赖与 Node 版本维护

开发、CI 与 Agent Docker 镜像统一使用 Node 24 LTS。`.nvmrc` 指定主版本，`package.json` 的 `engines` 为 `^24.0.0`，Node 类型定义也采用 24 系列。已安装 Node 25 的终端需要切换到 Node 24 后再运行 `npm install`；修改仓库配置不会更换系统 Node。

本轮更新 Electron 42、MCP SDK 2 与 sharp 的安全修订版本，并通过锁文件更新其余受影响的传递依赖。Electron 虽列在 `devDependencies`，仍是发布产品的运行时，因此不能只看 `npm audit --omit=dev`。

新版 npm 默认拦截未声明的依赖安装脚本。仓库显式禁用 `cpu-features`、`ssh2` 的可选原生加速编译，与桌面打包的排除规则一致，SSH 继续使用 Node crypto；同时禁用未使用的 Squirrel 安装器 `electron-winstaller` 的 7-Zip 选择脚本，Windows 发布仍使用 NSIS / MSIX。不要使用全量允许来消除提示；引入确实需要的脚本时单独核对用途和版本。

## 有范围的依赖覆盖

以下上游包尚未采用已修复版本，因此在根 `package.json` 按父包限定覆盖，不全局替换同名依赖。上游升级后应优先移除对应覆盖，再执行验证。

| 父包 | 覆盖版本 | 使用与验证 |
| --- | --- | --- |
| `@electron/get` | `global-agent@4.1.3` | 去掉旧日志依赖链；通过 electron-builder 实际使用的下载模块初始化代理，验证请求确实到达本机代理。 |
| `@file-viewer/core` | `dompurify@3.4.16` | 采用同一主版本的安全修订，保留文件预览的 HTML 清理。 |
| `concurrently` | `shell-quote@1.11.0` | 验证命令并发启动、正常参数解析，以及注释后换行注入被拒绝。 |
| `exceljs` | `uuid@11.1.1` | 保留 CommonJS API；验证实际依赖 UUID 的扩展图标集条件格式写入、重新读取。 |
| `pptxgenjs` | `image-size@2.0.4` | 当前 PptxGenJS 发布代码未调用此旧依赖；仍验证图片尺寸计算、嵌入内容与 PPTX 输出。 |

跨主版本覆盖需要调用路径验证，不能只凭 audit 数量判断兼容性。`npm run test:dependency-upgrades` 已加入 Windows / Linux 桌面 CI，覆盖上述运行路径和 sharp 的 SVG 渲染。

## MCP OAuth

SDK 更新之外，CardBush 的凭据提供器也实施 issuer 校验。预配置客户端密钥必须指定可信的 `expectedIssuer`，不能使用服务端新发现的地址给原密钥重新绑定。动态注册凭据必须保留 issuer；缺失标记时重新登录。配置方法见 [插件兼容性](PLUGIN_COMPATIBILITY.md)。

## 验证命令

```powershell
node --version
npm ci
npm audit
npm audit --omit=dev
npm run test:dependency-upgrades
npm run build
npx tsc --noEmit -p tsconfig.json
npm run test:mcp-integration
npm run test:document-plugins
```

不要使用 `npm audit fix --force` 批量引入未经验证的破坏性更新。优先同主版本安全更新；必须跨主版本时检查实际接口，并补充行为回归。审计结果只覆盖 npm 已知公告，不能替代产品安全测试。

参考：[MCP issuer 绑定公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)、[shell-quote 公告](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv)、[UUID 公告](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)、[sharp 公告](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)、[global-agent 发布记录](https://github.com/gajus/global-agent/releases)。
