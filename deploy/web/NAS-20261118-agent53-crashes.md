# 53 号机器蓝屏转储分析

## 结论

53 确实发生了蓝屏重启。最新一次为北京时间 2026-11-18 04:14:46.953，系统在 04:15:14.500 重新启动。转储、系统事件和启动时间互相对应。登录后出现终端不能据此认定没有重启；已有记录显示终端及 Agent 启动来自登录后的计划任务。

四份转储中，最强证据是最新的 `MEMORY_CORRUPTION_ONE_BIT`，以及 11 月 16 日异常指针中的单比特差异。综合判断应优先排查内存硬件链路的稳定性。现有小转储无法确认具体是哪根内存条、哪个插槽或 CPU 内存控制器，也不能完全排除驱动对内存的破坏。

没有证据可以将这几次蓝屏归因于网页待答逻辑；网页问题是远程离线后错误传播造成的另一层故障，现已通过独立读取、超时及错误状态隔离。

## 转储对照

时间均为 UTC+8，来自转储的调试会话时间。

| 时间 | 转储 | Bugcheck | 分析结果与限制 |
| --- | --- | --- | --- |
| 11-14 11:08:01.435 | `111426-17843-01.dmp` | `0x3B / 0xC0000005` | `TiWorker.exe` 上下文，`Ntfs+0x141bf` 访问违规；写目标 `rdx=0x100000`，不是正常内核对象地址。仅凭故障模块不能认定 NTFS 驱动有缺陷。 |
| 11-16 04:02:19.967 | `111626-16984-01.dmp` | `0x3B / 0xC0000005` | `svchost.exe` 上下文，`WdFilter+0x7996e` 读取异常地址；寄存器出现单比特差异，详见下文。 |
| 11-16 04:43:06.062 | `111626-14703-01.dmp` | `0x18B` | `HYPERGUARD_VIOLATION_DEMAND_PAGE_VERIFICATION_FAILED_1013_ffffffffc0000045_IMAGE_hyperguardviolation`；安全内核页面校验失败。该转储不能单独定位硬件或驱动。 |
| 11-18 04:14:46.953 | `111826-15859-01.dmp` | `0x1A / 0x41792` | `MEMORY_CORRUPTION_ONE_BIT`，`MODULE_NAME: hardware`，`IMAGE_NAME: memory_corruption`。 |

最新转储显示：

```text
PROCESS_NAME: backgroundTask
BUGCHECK_P1: 41792
BUGCHECK_P2: fffff500e0510dc8
BUGCHECK_P3: 1000000000000
BUGCHECK_P4: 0
MEMORY_CORRUPTOR: ONE_BIT
FAILURE_BUCKET_ID: MEMORY_CORRUPTION_ONE_BIT
```

调用栈经过 `MiDecommitHandlePageFileFormatPte`、`MiDeleteVa`、`MiDeleteVirtualAddresses`、`MmCleanProcessAddressSpace`，在退出进程、清理地址空间时发现损坏的页表项。微软对 `0x1A / 0x41792` 的定义是检测到损坏的页表项（PTE）；故障发生所在调用栈可能是受害者，不能直接视为破坏内存的来源。[微软 Bug Check 0x1A 文档](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/bug-check-0x1a--memory-management)

11 月 16 日 `WdFilter` 异常现场：

```text
rbx = ffffc908dbda61a8
rsi = fff7c908dbda61a8
instruction: cmp qword ptr [rsi+8], rbx
xor(rsi, rbx) = 0008000000000000
```

两个值只相差 bit 51。`rsi` 已不是有效的规范内核地址。这与最新转储的单比特损坏相互印证，但仍不能把寄存器值比较当成某一根内存条已损坏的直接证明。

`0x18B` 表示安全内核遇到致命错误，公开文档将参数列为保留值；上表更具体的校验失败分类来自 WinDbg 分析器，不能自行把参数解释成确定的硬件部件。[微软 Bug Check 0x18B 文档](https://learn.microsoft.com/windows-hardware/drivers/debugger/bug-check-0x18b--secure-kernel-error)

## 分析可靠性与现场补充

- 使用微软签名的 WinDbg 10.0.29680.1004，在本机离线分析转储；没有把转储上传到外部服务。
- 从 53 复制匹配的 `ntoskrnl.exe`（10.0.26100.9168），从微软公共符号服务器下载匹配的 `ntkrnlmp.pdb`，GUID/age 为 `72C69E726C648BC18257AF38FA78A2F21`。最终分析中 `nt` 显示为 `(pdb symbols)`，没有把早期缺少符号的结果作为最终调用栈。
- `Ntfs` 和 `WdFilter` 的专用 PDB 未加载，报告保留实际模块偏移和异常寄存器，不猜测内部函数名。
- 小转储包含数据扩展读取警告；最新转储标记 `Dump completed successfully`，错误码、参数和可读取的内核栈一致。未捕获的内存页及扩展数据仍构成分析限制。
- 内存为两条 King Tiger Technology 16 GiB，型号 `TMKUFG68AHFHD-32A`，报告配置 3200 MT/s、1.2 V。不能仅凭这些字段判断 BIOS 的 XMP 设置。
- 本次查询未找到内存诊断结果或近 14 天 WHEA 事件，这不等于内存已经通过检测。两块磁盘的系统健康摘要为 Healthy/OK，最新 NTFS 黑盒没有慢 I/O 超时或 Oplock 超时记录，也不能据此彻底排除存储故障。
- 恢复时首次启动 Agent 返回 `0xC0000005`，日志曾显示源码表达式异常，随后读取相同文件并执行语法检查却正常；重试原计划任务后启动成功。该现象支持继续排查内存稳定性，但不单独证明物理内存故障。

## 下一步定位边界

应安排维护时间运行 Windows 内存诊断，必要时由现场人员进行单条内存及插槽交叉测试。检测异常可进一步锁定部件；一次通过也不足以否定间歇性错误。微软将内存检测列为此类问题的排查步骤。[微软蓝屏排障指南](https://learn.microsoft.com/en-us/windows/client-management/troubleshoot-stop-errors)

本次优先恢复使用并完成网站断连隔离，没有再次重启 53 或启动需要停机的检测。尚未通过部件测试证明蓝屏根因已消除。

## 本地证据

原三份转储位于 `C:/Users/EDY/AppData/Local/Temp/cb-questions-20261117`。
最新转储、最终分析文本和现场读取结果位于 `C:/Users/EDY/AppData/Local/Temp/cb-questions-20261118`：

- `111826-15859-01.dmp`：5,446,739 字节，SHA-256 `e7360fbeef5b2c9b5384dc74e0e5ab19dc0a68e4607a8804bce72c881db5c10b`，复制前后校验一致。
- `111826-final-analysis.txt`、`111426-17843-final-analysis.txt`、`111626-14703-final-analysis.txt`、`111626-16984-final-analysis.txt`。
- `crash-readonly.txt`：系统启动、事件、内存、磁盘、计划任务及端口监听读取结果。
- `ntkrnlmp.pdb`：SHA-256 `522bcca703a7f5036a5c0b01080bd1a65a25f006a84da6cebd20cd59f3526722`。
