# Assistant 形象配置

默认像素机器人在 `pixelRobot.ts`。侧栏、会话标题、欢迎页、设置预览通过 `AssistantSkinContext` 读取同一份 `AssistantSkin`。替换时在共同的父组件注入另一份配置即可；所有入口都保留完整的动画角色。目前没有动画皮肤导入界面。

- **动作**：`portrait` 描述精灵图的行列和各状态片段，至少提供 `idle`。有限次动作结束后，可以用 `sustain` 指定一个局部变化的帧，和静止帧轮换。不提供对应状态时使用待命动作。
- **道具**：`pixelToolArt.ts`（位于 `features/tools`）把实际工具名称映射为文档、放大镜、终端等语义。工具记录使用默认图标。皮肤可通过 `props` 配置手持位置和占比（相对形象的百分数）、覆盖各类道具的 16×16 像素路径，并选择轻敲、扫描、书写或输入动作。没有挂点的皮肤不显示道具。
- **表情**：`expressions` 声明坐标系、每种心情的图层和动作。Assistant 的 `summary_for_user.expression` 可选 `happy`、`curious`、`caring`、`surprised`。表情只在对应回复发布后短暂显示；不会改变运行状态或写入用户偏好。

运行时只传递活动、工具名和临时回复表情，不保存图片或动作配置。窗口隐藏时暂停动画；启用减少动态效果时保留静态姿态和工具图标。

普通图片上传已下线：原 `assistantAvatar.ts` 的产品消费者只有设置、角色渲染和侧栏入口，现已移除对应读写、静态图片分支、上传样式及专用文案。旧的 `cardbush_personal_assistant_avatar_v1` 数据不再读取，也不主动删除，不会覆盖动作、表情、道具或舞台提示。`shared/avatarImage.ts` 及其语言键仍服务于个人资料头像，继续保留；图片校验回归由个人资料入口覆盖。`node scripts/test-assistant-ui.cjs --character` 在保留旧头像数据的条件下验证动画角色和设置行为，完整 Assistant UI 回归也会执行这些检查并覆盖欢迎页。
