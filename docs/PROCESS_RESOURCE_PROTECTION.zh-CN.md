# 进程资源保护

[English](PROCESS_RESOURCE_PROTECTION.md) · [简体中文](PROCESS_RESOURCE_PROTECTION.zh-CN.md)

Windows 托管命令经内置 `CardBushProcessHost` 执行：Shell 挂起创建，加入共享及任务 Windows Job Object 后再恢复。建立保护失败即拒绝，不回退不受限启动；工具参数不能提高或关闭宿主预算。

## 默认策略

| 资源 | 策略 |
| --- | --- |
| 任务内存 | 全任务树 committed memory，物理内存 25%，准入时按可用内存进一步收紧 |
| 共享内存 | 桌面 main 与 Runtime 托管树共享物理内存 50% 原生上限；准入扣除 Electron main/Runtime/renderer 实测使用及未消费启动预留 |
| CPU | 共享硬上限 80%，进程优先级 below-normal |
| 进程数 | 每任务树 64，共享 256 |
| 托管命令并发 | App main/Runtime 共 8，涵盖会话、fork、子 Agent、Hook、终端 |
| 持久 MCP 服务 | 独立 32 槽；串行替换可转移旧槽，但退旧树前仍需预留启动内存 |
| 服务内存 | 全树物理内存 25%，不永久收窄为启动瞬间空闲值；共享上限及实时压力检查继续生效 |
| 准入预留 | 物理内存 10%，限制在 512 MiB–1 GiB；任务启动预留 256 MiB、服务 128 MiB（不超过获准上限），不是插件总需求估计 |
| 临界内存兜底 | 2 秒采样，连续两次物理/commit 临界后先释放较大本地预览，否则一个较大任务，再服务；至少复测 6 秒再干预 |
| 磁盘压力 | 每 2 秒查工作/临时卷，低于 512 MiB 且任务期间下降超过 8 MiB 时停止 |
| 终端待发输出 | 每流 1 MiB |

内存上限是 Windows committed memory，不是精确 RSS。峰值计数可能包含被拒绝的分配尝试；测试检查成功提交/触碰和被拒绝分配，不要求峰值一定低于额度。

短命令正常并发，原生退出通知立即唤醒，不等 2 秒看门狗。没有全机进程枚举、WMI 或 PowerShell 监视，仅小型原生采样器查询已知 Job Objects，Electron 进程指标缓存 2 秒，500 ms 内结束命令不启动采样。助手在构建时编译；事件线程处理内存/进程限制。

共享原生上限固定物理 RAM，准入扣实时使用/预留，避免持久 MCP 把之后所有任务锁在启动时低内存预算。树生命周期内保留自己的已授予上限：短任务按准入余量收窄，服务使用配置上限，因后续工作可能在内存恢复后才开始；这不预分配整份服务上限。

准入错误包含 `limitingBudget`（`system_memory/system_commit/managed_group`）、实测内存、应用/托管使用、启动预留、所需字节、保留量和单项/共享额度，经过 main/Runtime RPC 留在工具回执。组额度失败不能说成物理 RAM 已耗尽。原生文件按内容版本不可变命名，原子 manifest 为新 Runtime 选择完整版本，老 Runtime 固定既有版本，构建不覆盖活动助手。

CPU/内存由内核强制；磁盘/系统压力只是尽力兜底，不能预留无关程序资源或统计任意其他卷。大表插件仍需临时/输出配额、流式 XLSX shared strings、预览上限和任务截止。持久终端不设随意墙钟截止。

## 生命周期、范围与兼容

- `terminal_poll/write` 合同不变，取消等待保留终端；`terminal_stop` 结束整树。脱离的后代随所属 shell/session 结束；持久后台工作需保持终端根及句柄。
- supervisor 崩溃关闭不可继承 job handle，Windows 清整树；它也监视固定 Runtime 父句柄。
- `resource_memory_limit/resource_process_limit/resource_memory_pressure/resource_disk_pressure` 和保护启动失败返回失败终态。共享分配拒绝也可能表现为子程序非零退出/stderr，减小负载/并发再重试。
- 桌面 Runtime 经私有 RPC 租用同一 governor/native group；worker 退出后预留保留 3 秒等待父句柄清理，独立 Runtime 使用本地 governor。
- 拥有的 stdio MCP 树及普通子进程受保护；外部 HTTP/SSE MCP、凭据助手、外部应用、独立浏览器不在此集成。系统“打开方式”故意启动独立程序；同步 Git/注册助手及 renderer 图像解码不在原生 job cap 内。预览内存释放是尽力措施，不是 renderer heap 硬限。新 worker 必须使用托管 API，安装 Skill 本身不会纳入保护。
- 原生 guard 为 Windows x64，其他平台目前仅准入记账，不等价强制 CPU/内存；WSL 只保护 Windows 启动器，Job Object 不限制 Linux VM 内部。

## 托管启动归属

轻量入口 `@cardbush/bush-runtime/processes` 保留环境、参数、stdin、退出码，Windows 无不受限回退。`ManagedProcessScope` 跟踪待启动和活动树，关闭后拒绝新启动并等待退出，异步准备后再查取消。Unix 清理所属进程组为尽力执行。

| 入口 | 生命周期 | 内存输出 |
| --- | --- | --- |
| Agent 终端/搜索 | 终端会话/搜索调用，取消终端等待不杀执行 | 终端每流 1 MiB，搜索每流 2 MiB |
| 插件/命令 Hook | 调用 abort、原 Hook 截止，根退出清树 | 默认合计 256 KiB，超限停止 |
| stdio MCP | 连接拥有者；断连、实际禁用/移除、替换、退出 | SDK 有界换行读取，持续排空 stderr |
| UI 终端 | renderer 关闭/重载/崩溃/销毁 | 流到 renderer，main 不积累历史 |
| UI 一次命令 | renderer 与应用 | 运行滚动尾 80 KiB，返回每流最多 20,000 字符及 `outputTruncated` |
| 插件 Git/npm 获取 | 应用操作，60 秒截止，等待命令清理 | 合计 4 MiB，超限停止 |
| Blender 预览 | 请求取消/dispose、应用及原转换截止 | 尾 24 KiB，错误最多 6,000 字符 |
| Office 兼容预览 | 受保护 worker，树 512 MiB，取消/20 秒截止 | 合计 24 MiB |
| Windows 文件剪贴板助手 | 应用，5 秒截止 | 合计 16 KiB，超限停止 |

以上 Electron 入口共用 app scope；单窗关闭只取消自己的终端，退出应用关闭整体。任务完成不关闭别窗终端或共享 MCP/浏览器。main 和 Runtime 同样从 asar 外解析原生资产；边接收边截断，不能先积累无限字符串。

## MCP 服务

stdio 通过 `ManagedProcessScope` 启动。Windows 小型 Node 适配器在 native job 中保留 SDK PATH、`.cmd`、参数和环境，随服务存活，不按工具调用重启。启动需 MCP 握手及完整发现。

关闭先发 stdin EOF，给 1 秒协作退出，再停整树并等待；重复关闭共用完成状态，启动取消/迟到 SDK 不遗留进程，Runtime 崩溃同样清理。不按进程名/端口搜杀，也不逐工具扫描。

替换按当前连接管理边界处理：等待受影响已分派调用结束，预留启动资源，关旧树后起新树。资源不足显示 `waiting_for_resources`，原连接仍可用；2 秒后在握手截止和发现槽之外重试。禁用、替换为更新版本、关闭会取消工作，恢复不能复活已取消启动。同 server ID 串行，避免争旧端口。失败替换不可保留旧进程作原子回滚；HTTP/SSE 只管连接，不终止外部服务。

普通产品会话在模型边界接收增量目录变化，不改冻结顶层工具或越过审批。新可选服务可在活动 turn 发布，已发调用保留旧版本；必需服务事务保持原子性，子/插件 Agent 和定时作用域不自动扩张。连接生命周期以[插件兼容文档](PLUGIN_COMPATIBILITY.md)当前实现为准。

自动恢复指数退避，最多 3 次实际重启，健康 60 秒才恢复预算；手动重连重置预算，等待资源不计次数。只恢复连接，不重放业务调用。原生退出码、峰值/额度等保留诊断；迟到原生回执可完善 EOF，不触发第二次重启。恢复后 timestamped `lastFailure` 保留中断原因。关闭拥有者取消退避。普通 turn 共用应用连接，插件 Agent 独立 MCP scopes 互不误关，应用拥有者关闭清理全部。

这不提供独立 daemon 声明，也不协调磁盘插件包替换。OS 服务、计划任务、容器或逃离树的进程需显式归属集成；Unix 无 Windows 等价崩溃/资源保证。

## 预览、文件和工作区

本地文件/媒体用打开句柄流式读取，64 KiB 块和按字节计的 128 KiB 响应队列；HEAD 不读正文，取消关闭流，增长不扩展本次响应。Office 解码前只读有界 ZIP 元数据：压缩 32 MiB、声明展开 128 MiB、单项 32 MiB、10,000 项。超大/ZIP64/加密/无效文件仍可作为文件使用，预览明确原因，这不是编辑限制。

Office 兼容解析在 main 外受保护 worker，完整视觉 renderer 在隔离 webview。单预览超过 `min(1 GiB,max(256 MiB,8% RAM))`、总预览超过 `min(2 GiB,15% RAM)` 或持续临界压力时释放；与会话/远程网页共进程的不选。沿用预览失败/重试 UI，不替换整个 App。图像/GPU、外部应用、WSL 等仍无绝对全应用 OOM 保证。

`read_file`、写/改前快照、Node 搜索回退单文件 8 MiB，stat 快拒绝后仍流式检查增长；大文本支持范围读，选中内容最多 2 Mi 字符（含超长单行）。SHA-256 流式；超大写入或替换膨胀在修改前拒绝。搜索跳过/截断/中断明确不完整；原生搜索受托管、30 秒、2 MiB 限制，缺二进制可退有界 Node 读取。

检查点大于 8 MiB 文件经 Git `hash-object -w`、`core.bigFileThreshold=8m`，不走 fast-import 缓冲，哈希仍检查并发变化。审查先查对象大小，超过 128 KiB 省略内容 diff、保留对象身份，小 diff 有界批次处理。流式恢复未实现前，恢复/复制所请求 blob 总量超过 64 MiB 在改文件前拒绝并报 `workspace_resource_limit`，文件和版本完整保留；大基线 worktree 同限，direct 模式可记录大产物。这是明确限制，不宣称大表恢复已全实现。

## 验证

```text
npm run build:runtime
npx tsc -p tsconfig.node.json
node --test packages/bush-runtime/test/processResourceGuard.test.mjs packages/bush-runtime/test/workspaceTools.test.mjs packages/bush-runtime/test/managedProcessCommand.test.mjs scripts/test-host-processes.mjs
node --test packages/bush-mcp-client/test/resourceAdmission.test.mjs scripts/test-resource-coordination.mjs scripts/test-office-preview-resources.mjs
node scripts/test-plugin-acquisition.mjs
node scripts/test-plugin-extensions.mjs
node scripts/benchmark-process-resource-guard.mjs
electron scripts/test-process-resource-electron.cjs
```

原生测试使用低额度、有界 fixture，内存分配 fixture 即使 guard 回归也不超过 512 MiB。覆盖树/共享内存、进程数、CPU、24 MiB 磁盘压力、stdin、Unicode/转义、退出码、停止、父退出、孤儿清理、准入共享、启动失败及短命令响应。benchmark 预热两次后交替直接/保护启动，报告中位数和 p95；每条命令付一次 supervisor 启动成本，poll/output 不再启动。

参考：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[内存限制](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)、[CPU rate](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information)。
