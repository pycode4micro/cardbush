# 本次商店介绍同步内容

供发布者更新 Partner Center 已有介绍和隐私说明的对应段落。保留真实的支持联系方式和隐私政策 URL；这些材料不会自动修改商店页面。

## 系统要求

简体中文：

> 需要 Windows 11 x64（版本 21H2 / build 22000 或更高）。当前包不支持 Windows 10、ARM64、32 位 Windows 或 S 模式。可选 Browser Use 功能支持 Windows 上的 Google Chrome 和 Microsoft Edge，需要安装随应用提供的扩展并主动配对。AI 功能需要用户配置可用的模型服务，服务费用按所选提供商的规则计收。

English:

> Requires Windows 11 x64, build 22000 or later. This package does not support Windows 10, ARM64, 32-bit Windows or S mode. Optional Browser Use supports Google Chrome and Microsoft Edge on Windows and requires the bundled extension and explicit pairing. AI features require a configured model service; provider usage charges may apply.

## 浏览器功能

简体中文：

> Browser Use 默认关闭。用户启用后，可分别配对 Chrome、Edge 或不同浏览器配置，选择默认连接，并随时移除单条连接或关闭全部连接。配对不等于授权所有个人网页；已有网页需要另行选择和授权。连接使用经过身份验证的本机通信，会话之间保持页面隔离。

English:

> Browser Use is off by default. After enabling it, users can independently pair Chrome, Edge or separate browser profiles, choose a default connection, revoke individual connections or disable all connections. Pairing does not grant access to all personal tabs; existing pages require separate selection and authorization. Connections use authenticated local communication with session-separated pages.

## 隐私与卸载说明

简体中文：

> 执行用户指示的 AI 任务时，授权页面的文字、截图和操作结果可能发送至用户配置的模型服务。应用不会为浏览器连接器直接扫描浏览器密码或 Cookie 数据库。连接器的配对凭据和连接设置保存在当前用户的 MSIX 应用数据中；关闭连接器会撤销配对凭据。正常系统卸载会清理包所属的应用数据，但不会删除用户另行保存的工作区文件、浏览器配置或手动加载的浏览器扩展。历史版本留下的外部连接器注册需要按照应用提供的迁移说明单独清理。

English:

> For user-directed AI tasks, authorized page text, screenshots and action results may be sent to the user's configured model service. The browser connector does not directly scan browser password or Cookie database files. Pairing credentials and connection settings are stored in the current user's MSIX application data; disabling the connector revokes pairing credentials. Normal system uninstall removes package-owned application data while preserving separately saved workspace files, browser profiles and manually loaded extensions. External connector registrations from older releases require the documented separate migration step.

## 截图与审核信息

- 当前已准备中英文各 4 张 1920 × 1080 PNG，包含会话、应用中心、Browser Use 和定时与自动化；预览、ZIP 和上传顺序见[截图交付记录](../../docs/MSIX_STORE_SCREENSHOTS_2026-09-29.md)。界面使用独立演示数据，尚未代为上传。
- 将旧的 Chrome 专用连接器名称和截图换成当前 Browser Use 页面，显示 Chrome / Edge 选择与连接管理。
- 不沿用“Windows 10 兼容”“需要 Native Messaging 注册”“卸载总会保留对话和设置”等旧版 MSIX 说明。EXE 与 MSIX 的安装及卸载行为分开说明。
- 现有截图若含配对码、API Key、个人网页或真实对话，重新取样后再上传。
- [审核短说明](notes-for-certification.en.txt)说明模型配置要求；如需验证完整 AI 任务，发布者需在 Partner Center 私密审核信息中提供实际可用的测试方式。
- 最终上传版本和验证边界见[提交准备记录](../../docs/MSIX_SUBMISSION_PREPARATION_2026-09-29.md)。这些文案不构成 Store 审核已通过的声明。
