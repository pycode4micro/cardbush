# Windows 拦截调查与处理建议

调查时间：2026-09-28，Asia/Shanghai。代码基线：`3c936d432fb4e853a94bff37ebedb608a0b9d88e`，包括当前未提交的修复。初次调查来自本机只读诊断、两个进程宿主的 `--capabilities` 启动检查、包内文件验签及官方文档，当时未修改 Windows 保护策略、未向外部提交文件。随后维护者选择暂时关闭 SAC 进行本机开发，验证结果见下。

## 后续开发环境验证（2026-09-28 12:37，Asia/Shanghai）

维护者明确改为“开发期间关闭 SAC，取得商店或 SignPath 签名后再启用保护”，并亲自在 Windows 安全中心关闭开关。只读复核确认 `SmartAppControlState=Off`、`VerifiedAndReputablePolicyState=0`；Defender 防病毒、实时防护与篡改防护仍为开启。

- 原先被拦截的 `CardBushProcessHost-b1ab6c67059faa5f.exe` 和当前 `f8ed893fc21d3109` 版本均通过 `--capabilities` 启动检查。
- `CardBushBrowserHost.exe` 通过 Native Messaging 协议往返、重启恢复和来源拒绝测试。
- 原先被拦截的 `CardBush-6fd8f6b20cb2077d7d0220ff27bdc04eb8f23951deba70d78673352588d6b2bb.dll` 成功由 Windows PowerShell 加载；其 SHA-256 与初次调查一致。
- 上述验证期间没有新增 Code Integrity `3077` 事件，事件日志读取正常。
- 记录保存在 Git 忽略的 `tmp/application-control/manual-toggle-baseline.json` 和 `manual-toggle-verification.json`。没有重新编译被拦截文件来改变其指纹，也没有安装或生成签名证书。

这确认了这些原生组件在当前开发环境中的 SAC 阻塞已解除，不代表已签名或已通过保护开启环境的发行验收。完整电脑操控交互和真实 Chrome 扩展连接尚未复测。重新启用 SAC 后须针对实际签名版本重新执行完整验收。

## 已确认的直接原因

三类组件都出现了同一智能应用控制策略的拒绝。Code Integrity 事件 `3077` 的 XML 明确包含：

- PolicyName：`VerifiedAndReputableDesktop`
- PolicyGUID：`{0283ac0f-fff1-49ae-ada1-8a933130cad6}`
- Status：`0xc0e90002`
- 本机 `VerifiedAndReputablePolicyState=1`。

事件消息里的 “Enterprise signing level” 是通用描述，不能据此认定电脑被企业接管。相关 Defender 检测记录查询没有返回 CardBush 的恶意软件检出；这不是一次完整恶意软件审计。

| 组件 | 本机证据 | 结论 |
| --- | --- | --- |
| Computer Use | 加载 `CardBush-6fd8f6b20cb2077d7d0220ff27bdc04eb8f23951deba70d78673352588d6b2bb.dll` 返回 `0x800711C7`；02:19:11/12 的 3077 事件指向同一文件 | 原生库加载被 Windows 阻止，不是模型不会操作，也不是再次观察窗口可以修复 |
| Chrome 浏览器助手 | 3077 指向 `dist-native/chrome-connector/CardBushBrowserHost.exe`；HKCU 的 Native Messaging 注册清单指向的正是这个文件，扩展 origin 也匹配 | 桥接 EXE 在执行前被拦；注册路径存在，继续调整网页权限解决不了这个故障 |
| 旧进程宿主 | 03:39:10 对 `CardBushProcessHost-b1ab6c67059faa5f.exe --capabilities` 的复现返回 Node `UNKNOWN/-4094`，同期 3077 指向该文件 | 用户原始构建报错有明确的系统策略证据，不能仅凭 `UNKNOWN` 猜成 Node 24 缺陷 |
| 当前进程宿主 | `CardBushProcessHost-f8ed893fc21d3109.exe --capabilities` 返回 0，协议及 sandboxVersion 正确 | 当前这一份可以启动；它仍未签名，不能据此保证下一次构建或另一台电脑也能启动 |

关键文件的 SHA-256（文件名中的散列不一定是文件本身的 SHA-256）：

| 文件 | SHA-256 |
| --- | --- |
| Computer Use 的 `6fd8…dll` | `FAF488600EA553F68DBCC9051112C6C1F0E0234753F5CA32E490DC767C1820CD` |
| `CardBushBrowserHost.exe` | `B24A58C10ADBA9EDE680DBE9779B79E78C0D445F522DD1DFF0BC3219BDFC1C76` |
| 旧进程宿主 `b1ab…exe` | `FC1D3CA1D5624C65EF2EA0B29461D8EF0063DBDA03DD021533860D5FF8DC71A4` |
| 当前进程宿主 `f8ed…exe` | `ABB5CB0437595DD6B502A9583159DA72C69B502551DA30F5B4BBECFAE2764828` |

## 为什么之前能用，现在失败

**Computer Use 有明确的加载路径变化。** 9 月 27 日的 `3c936d4` 新增 `computerUseNativeCode.ts`，把原先运行时编译的固定 C# 辅助代码改为生成并加载持久 DLL。当前被拦文件是该路径的产物，最后写入时间为 9 月 27 日 23:38:32。这是本次功能回归最明确的代码触发点。没有对旧版在同样策略下做完整 A/B 验收，因此不宣称简单回退就能稳定解决。

**浏览器助手不是这次 Computer Use 更新才出现的。** 当前文件最后写入于 9 月 20 日；对应 `832b75d` 修改了 MSIX 下的配置发现和浏览器握手。它一直是单独编译的 EXE，没有可信发布签名。尚不能证明具体在哪次 Windows 更新或云端信誉变化后首次被拦。

**应用控制问题早于 9 月 27 日。** 已提交的 `df8b654` 文档记录了 9 月 21 日临时 `resource worker.exe` 被应用控制拦截、导致 10 项测试失败的情况。不能把所有问题归咎于 9 月 27 日 Windows 突然更改策略。

微软说明：没有足够安全信誉的未签名代码会被 SAC 拒绝；不同文件不自动共享整个应用的信任。因此两份均未签名的进程宿主一份能启动、一份不能启动，并不矛盾。实际云端判定依据没有在本地事件中完整公开，不能进一步声称已查明它们信誉不同的内部原因。[SAC 原理](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)

历史证据有明确边界：本机 Code Integrity 日志约 1 MB，循环覆盖，没有找到该日志的归档。本次快照只保留近约两小时；“最早保留事件”不等于“第一次拦截”。策略枚举工具在当前权限下返回拒绝访问，策略归因使用的是事件内明确记录的名称和 GUID。

## 为什么会一直重复提示

本次快照中，浏览器助手有 206 条 3077 拒绝，间隔约 30 秒。Chrome 使用源码目录中的开发扩展，注册目标也是工作区 EXE。

当前修复源码已采用三次失败后暂停、30/60 秒退避、保存暂停状态的逻辑；仍持续出现的 30 秒拒绝说明实际运行行为尚未切换到该修复。需要重新加载扩展或在保存浏览器工作后重启浏览器，再验证真实行为。编辑磁盘文件不等于已更新正在运行的扩展工作进程。暂停重试只能减少干扰，不会改变 Windows 对文件的信任判断。

## 发布包检查发现

检查对象：`release-msix/1.0.3.0-6oqMsF/extracted-msix`，即此前生成的未签名 Store 暂存包，未在本机安装。

- 发现 42 处 Windows PE 文件：40 处 `NotSigned`，2 处有有效微软签名；40 处对应 30 个不同文件摘要，含重复副本。这不是 40 个已复现的故障。
- 除自己的助手和 DLL，还包括 Electron 图形/媒体库、Sharp/libvips、ripgrep、SSH 的 Pageant 辅助程序等。只签最外层安装器不足以完成独立 EXE 的可信组件交付。
- 进程宿主打包通配符带入了 7 个历史版本，实际清单只选择 `f8ed…exe`。其中 6 个不再使用，含已确认被拦的 `b1ab…exe`。应改为只携带清单选中的版本；本次调查没有删除本机旧文件或改写既有安装包。
- Computer Use 原生库在 workspace 路径和 `node_modules/@cardbush` 路径各有一份。后续可以合并，但必须先验证两种模块解析路径；不能直接删除其中一份。
- 未签名是 Store 上传前的正常状态，不代表未来通过 Store 安装后仍是相同信任状态。直接解压暂存包运行也不能替代商店安装验收。
- 已有预检确认独立 EXE 的签名身份尚未配置；MSIX 本地身份格式可用，但 Partner Center 状态未核对、商店认证未完成。

已核对 electron-builder 26 的实现：额外资源在复制时走签名转换，根目录及 ASAR 外部二进制另有签名遍历。当前 EXE 配置包含 `.exe/.dll/.node`，并在签名后递归验收。没有实际签名凭据时，这些配置和单元测试不能证明真实发行物已签名。

## 推荐方案与执行顺序

**主方案：先以 Microsoft Store MSIX 完成一个保持保护开启的可用版本，再完成独立 EXE 的发布签名。** 依据是开发者已有 Store 身份、是中国大陆个人、希望保护保持开启且避免不必要的证书开支。MSIX 通过 Store 认证后由微软重签；直接上传 EXE/MSI 到 Store 不享受这项代签。商店认证不是自动批准。[微软签名选项](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)

1. **整理发布输入。** 只打包当前宿主；自己的 Computer Use 操作库和提示浮层全部预编译，发行时不在用户机器上另编译替代 DLL；核对所有本机依赖的来源与固定版本。
2. **分开编译、签名、运行验收。** 当前 runtime 构建会在签名前启动进程宿主，遇到 SAC 拒绝时仍可能卡在这里。EXE 流程应在宿主可信签名后执行启动检查；Store 暂存阶段只做编译和包结构检查，把完整运行检查保留到商店签名安装后。这是尚需落地的发布流程改进，不能把未执行的检查算作通过。
3. **完成 Store 安装验收。** 核对 Partner Center 身份、版本及当前提交状态；认证后从 Store 安装。终端、搜索、Computer Use 观察/截图/输入/用户接管、Chrome 原生握手，以及新 Windows 用户下的数据隔离全部通过，且同期无对应的 3077 拒绝，才认定解决。具体步骤见 [Store 提交流程](../packaging/msix/store-submission.zh-CN.md)。
4. **独立 EXE 使用可信发布身份。** 先确认 Certum Standard 对中国大陆个人证件、地址证明及云端验证的支持，再购买。其官方材料明确支持个人，但这不能替代对大陆申请条件的确认。不建议为消除提示额外买 EV；新签名的独立下载仍可能有 SmartScreen 信誉提示，与此次 SAC 执行阻断应分开验收。[个人材料要求](https://support.certum.eu/en/code-signing-required-documents/)、[Standard 产品](https://shop.certum.eu/standard-code-signing-in-the-cloud.html)、[SmartScreen 信誉](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
5. **本地开发复用已验收的固定辅助组件。** 普通 JS/TS 开发不必每次重编原生库；原生源码变化时重新经过可信构建及签名。不要靠反复生成不同文件碰运气，也不要回退成无进程保护的执行。

SignPath Foundation 适合作为开源项目的免费候选，但不应被当作这次全部问题的确定答案：它要求审核，限制仅签自己维护源码产物，普通上游未签名 DLL 不能直接借项目证书代签。当前包确有此类依赖，必须先取得上游可信产物或确认其他合规交付方式。申请前还需补齐自己辅助组件的产品名/版本信息，当前事件所见为 `0.0.0.0`、缺少产品名。[基金会条件](https://signpath.org/terms.html)

另有微软文件复核渠道，允许选择 Software developer 和 Smart App Control。可提交目前实际被拦的浏览器助手和 Computer Use DLL，请微软复核；结果和时效无法保证，也不能保证下一次重编后的文件继承结果，因此只作为并行补充。本次已在本地准备文件与英文说明，未上传。[微软文件分析入口](https://www.microsoft.com/en-us/wdsi/filesubmission)

## 多用户和隐私

代码签名确认发行者及文件完整性，不会把所有使用者登录为开发者，也不需要把开发者私钥安装到用户机器。公开可见的是证书中的发行者信息；个人证书应先确认公开字段，不能承诺匿名。

现有浏览器注册使用 HKCU，管道名从用户数据路径派生，连接需要每次生成的令牌，配置保存在用户数据目录。这是按用户区分的设计证据，不是完成多用户安全验收的替代品。私钥、API 密钥、会话和本机配置不得放入发行物；现有打包隐私检查只是检查常见误打包，不是完整隐私审计。商店签名也不会自动覆盖安装后下载的第三方插件二进制。

## 本次交付和未完成项

本次新增调查报告，并在被忽略的 `tmp` 中保存三组本机证据（策略事件、旧进程宿主复现事件、包内签名清单）及两份可供微软复核的文件副本。没有改 Windows 策略、授予自签根信任、上传二进制、申请证书、购买服务或发布应用。

直接阻断原因已经确定；浏览器最初从哪一天开始被拦，以及微软云端对某个未签名散列作出判断的具体内部理由，现有证据无法恢复。最终解封仍需取得可信发行物并完成上述安装验收。此前的失败止损、发布检查和启动冒烟测试，不代表这些原生功能已恢复。
