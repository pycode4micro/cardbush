# Friends demo 源码归档

这是一份 2026-11-04 服务器实验的冻结快照。先看 [综合报告](REPORT.md)，原始结果分别见 [v4](v4/RESULTS.md) 和 [v5](v5/RESULTS.md)。源码保留原样，不在本次归档中重构或重新运行真实模型场景。

## 目录

```text
friends-loop/
  REPORT.md                   综合结论、架构归属与能力边界
  archive-manifest.json        原始 65 个文件的路径、长度及 SHA-256
  verify-archive.mjs           只读校验，不加载 demo 或模型
  v4/                         目录感知与两个模拟日实验
    runs/nba-01/               JSON 审计、测试结果、终轮与产物
  v5/                         真实时间、真实网页的短场景实验
    versions/initial/         首轮修复前的部分源码
    runs/live-01/             首轮失败记录
    runs/live-02/             观察程序提前退出的记录
    runs/live-03/             最终实例、原始终轮与内容复核
```

v5 的 `environment-service.mjs` 导入 `../v4/environment-service.mjs`，因此两个版本一并保存。`versions/initial/` 是首轮若干文件的历史快照，不是可单独启动的完整目录。

## 归档完整性

在仓库根目录执行以下命令，只读取文件并比对哈希，不创建运行数据、不访问网络、不调用模型：

```sh
node cardbush-subproj-demo/friends-loop/verify-archive.mjs
```

归档从 `/opt/friends-loop-demo-20261104` 提取源码、模板、原始报告、文本审计、终轮和产物。未携带 `model.private.json`、SQLite 数据库、日志及原有 ZIP。导出时检查了私有模型配置值与常见凭据格式，未发现匹配。Git 属性固定快照文件使用 LF，以保持原始哈希。

`audit.json` 是原运行导出的可读证据，不是可以原地续跑的数据库备份。`heartbeat.json`、`verification.json` 和旧文档中的 PID/运行状态仅表示写入时状态。归档时再次只读核查：v4/v5 测试服务均 `inactive/dead`，正式服务 `cardbush-agent-42.service` 为 `active/running`、PID `1480462`。

## 执行环境与路径约束

原环境是 Linux、Node.js `v24.22.0`、Python `3.12.3`、curl 与 systemd。`node:sqlite` 是 demo 的持久存储依赖。实际模型通过 Cardbush provider 远程调用，没有部署本地模型进程。

源码保留以下服务器绝对路径：

- 实验根目录：`/opt/friends-loop-demo-20261104`。
- Runtime：`/opt/cardbush/releases/1.0.14-20261102-1549/packages/bush-runtime/dist`。
- Provider：同发布目录的 `packages/bush-provider-openai/dist`。
- 私有模型配置：实验根目录下 `model.private.json`；由原环境提供，本仓库不包含配置值。

`main.mjs` 会校验隔离运行路径，`stop` 使用 Linux `/proc` 核对进程。测试和 systemd 模板也保留原路径。因此这份快照不能直接在 Windows 仓库目录执行场景；迁移时要显式适配路径与 Runtime 依赖，不能仅移动 `v5/` 或把旧服务文件直接注册到本机。

## 原服务器上的复现入口

以下是原服务器环境的命令说明，本次归档未执行它们。基础测试不请求真实模型：

```sh
node /opt/friends-loop-demo-20261104/v4/tests.mjs
node /opt/friends-loop-demo-20261104/v5/tests.mjs
python3 /opt/friends-loop-demo-20261104/v5/test-web-transport.py
```

在依赖和私有模型配置齐备时，使用一个尚不存在的独立目录初始化短场景；不要覆盖 `live-01` 至 `live-03` 的历史数据：

```sh
node /opt/friends-loop-demo-20261104/v5/main.mjs init \
  /opt/friends-loop-demo-20261104/v5/runs/replay-new \
  /opt/friends-loop-demo-20261104/v5/habit-short-template.json
node /opt/friends-loop-demo-20261104/v5/main.mjs serve \
  /opt/friends-loop-demo-20261104/v5/runs/replay-new
```

模板以启动时真实时间加 120 秒形成阅读 habit，没有预填来源或工作事件。`serve` 会真实联网并调用配置的模型，有 20 分钟实验窗口和 80 次模型请求上限。终轮保存在新 run 的 `latest-final-reply.txt`；可用 Ctrl+C 结束前台进程。

原 `monitor.py` 与 `.service` 绑定固定测试服务名和旧运行目录，不能把它们当作上面新目录的通用启动器。它们仅作为原测试监督与部署证据保存。原始 `monitor.py` 的通过结果仍需独立内容复核，不能取代 `semantic-review.json`。
