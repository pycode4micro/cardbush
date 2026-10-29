# Cardling 桌面伙伴

[English](cardling-system.md) · [简体中文](cardling-system.zh-CN.md)

参考图：`cardling-concepts.png`。

Cardling 是 CardBush 的小型桌面状态对象，不是覆盖产品的独立角色。基本轮廓是圆角卡片、小叶子、柔和的状态眼睛和轻微动画。形状应便于 CSS、SVG、Lottie 或 Rive 渲染；发光/活动态沿用应用强调色，优先小幅循环动作。徽章靠右下边缘，展开为紧凑状态面板，避免遮挡聊天。

| 状态 | 含义 | 视觉提示 |
| --- | --- | --- |
| idle | 就绪 | 缓慢呼吸 |
| thinking | 正在生成 | 双眼交替脉冲 |
| tool | 工具/文件操作 | 扫描线与光标标记 |
| waiting | 等待输入或选择 | 暖色叶片 |
| queued | 用户消息排队 | 卡片堆叠及计数 |
| complete | turn 完成 | 短暂闪光 |
| error | 操作失败 | 红色角标 |

## 实现与交互

- 主界面回退组件：`src/App.tsx` 的 `CardlingCompanion`；独立窗口：`src/CardlingWindow.tsx`；窗口宿主：`electron/main.ts` 的 `createCardlingWindow`；样式：`src/styles/app.css` 的 `.cardling-*`。
- 设置 → Cardling 管理可见性、大小、透明度、动画强度和位置重置，并列出各状态的触发条件/视觉提示。
- 输入包括发送状态、排队数、待处理交互、运行中工具、改动数和错误。无错误完成 turn 后短暂进入 complete。
- Electron 创建透明、无边框、置顶窗口，可拖动并在应用数据目录保存位置。
- 聊天有文件差异时，面板能打开现有差异对话框，或调用现有反向差异全部撤销流程。

## IPC

主应用发送 `cardling:update-state`，桌面窗口接收 `cardling:state`。桌面窗口通过 `cardling:action` 发起设置/差异/撤销，用 `cardling:set-expanded` 和 `cardling:move-by` 调整面板及拖动。设置页可发 `cardling:reset-position`。

## 后续方向

可将 CSS 形状导出为托盘/关于页 SVG 回退；只有交互确实需要更丰富的过渡时才改用 Rive 或 Lottie。
