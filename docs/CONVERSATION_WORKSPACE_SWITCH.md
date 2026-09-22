# 会话切换工作区

已有会话可通过顶部工作区按钮或侧栏右键菜单切换项目。将会话拖到目标项目可直接切换；拖到“最近”则改用该会话的独立工作区。置顶会话也可拖动，置顶状态保持不变；拖入输入框仍用于引用会话。

切换保留会话 ID、消息和工具执行记录，不移动、复制或删除原目录中的文件。后续回合使用新目录，并重新读取该目录的上下文。切换到另一个项目会为其建立新的 Git 版本基线；原工作区的检查点不用于新工作区的文件撤回，旧消息中的文件路径仍指向原文件。

当前会话、子任务或工作区终端仍在运行时不能切换；排队消息也须先处理完。其他独立会话正在运行不妨碍切换。缺失或归档的项目不能作为界面中的目标。独立 Worktree 副本需要先审查修改、按需应用，然后丢弃副本；切换不会隐式丢弃它。未完成的版本检查点需要先补建。

实现使用 `runtime.switch_workspace` 同时更新 Runtime 的目录绑定和会话项目元数据，普通 metadata 更新仍不能重绑托管工作区。界面在成功返回后才更新归属，失败会保留原显示并报告错误。

验证：

- 编译 `@cardbush/bush-protocol`、`@cardbush/bush-runtime` 后运行 `node --test packages/bush-runtime/test/workspaceSwitch.test.mjs`。
- 使用 Electron 执行 `scripts/test-welcome-ui.cjs`；此测试使用隔离的离屏窗口与模拟会话，不调用模型或访问用户资料。
- 工作区回归：`node --test packages/bush-runtime/test/taskWorkspace.test.mjs packages/bush-runtime/test/workspaceRevert.test.mjs`。
