# Logic 工具迁移

`consult_logic` 和 `learn_logic` 已从 CardBush 内置中移除，源码、经验库实现与回归测试迁移到 `pycode4micro/cardbush-plugins` 的 `plugins/logic-memory`。该插件在市场中标记为 `AVAILABLE`，需要用户自行安装、启用，不属于宿主内置或默认插件。

插件使用标准 MCP stdio，仅依赖本机 Node.js；分发目录包含独立 JavaScript 运行文件。CardBush 通过原有插件发现、MCP 连接、权限和卸载流程使用它，没有专用注入、反向接口或自动安装逻辑。

宿主不再创建、读取或写入 `lem/logic.json`，也不导出 LogicMemoryStore。回复点赞保留现有本地记录，移除自动关联经验、写入经验反馈的接口和 UI 文案。执行历史搜索保留通用 BM25 评分器，已与经验工具分离。旧日志中的自动 LEM 提示继续被上下文兼容过滤器排除；历史日志保持原样。

原有 `<运行数据目录>/lem/logic.json` 不删除。新插件默认使用 `~/.logic-memory/logic.json`，支持以 `LOGIC_MEMORY_DATA_DIR` 指定目录。显式导入命令复制经过验证的旧数据，保留原文件并拒绝覆盖已有目标：

```text
node <logic-memory 插件目录>/runtime/cli.mjs import --from <旧 logic.json 的绝对路径>
```

反馈不再依赖 CardBush 的 session/turn 元数据，使用普通工具参数 `source_id` 标识同一反馈事件并保证重试幂等。检索仅为词法候选，不构成授权或事实核验。
