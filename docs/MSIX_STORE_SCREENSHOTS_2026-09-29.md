# CardBush 1.0.5.0 商店截图

已准备简体中文 `zh-CN` 和英文 `en-US` 各 4 张，统一为 1920 × 1080 PNG。仅生成本地材料，尚未代为上传 Partner Center。

- [完整预览](../release-msix/1.0.5.0-13UXTU/store-screenshots/index.html)
- [8 张原图与说明 ZIP](../release-msix/1.0.5.0-13UXTU/store-screenshots/CardBush-1.0.5.0-store-screenshots-zh-CN-en-US.zip)
- [中英文配图说明](../release-msix/1.0.5.0-13UXTU/store-screenshots/captions.tsv)
- [文件尺寸与 SHA-256 清单](../release-msix/1.0.5.0-13UXTU/store-screenshots/screenshots.json)

| 顺序 | 页面 | 内容 |
| --- | --- | --- |
| 01 | 会话 / Conversations | 示例会议记录、行动清单和后续确认事项 |
| 02 | 应用中心 / App Center | 插件、自动化、设置与个人网页快捷方式 |
| 03 | Browser Use | Chrome / Edge 独立连接、默认浏览器和撤销操作 |
| 04 | 定时与自动化 / Automations | 日历、每日任务、展开的详情与管理操作 |

## 来源与边界

使用当前产品的正式 React 界面组件、现有样式和中英文文案，在隔离的离屏渲染器中取图；没有重画界面、修改组件样式或叠加营销文案。视口为 1600 × 900 CSS 像素，按 1.2 倍像素密度直接渲染为 1920 × 1080，未对成图放大。

会话内容、模型名称、浏览器连接状态、网页快捷方式和自动化计划均为独立演示数据。没有读取真实用户配置或对话，没有调用模型或执行桌面、浏览器和定时任务，也没有读取 Cookie、配对码或密钥。截图用于商店展示，不作为 MSIX 安装或端到端功能验证证据。

## 验收与上传

- 两种语言各 4 张，均通过 PNG 尺寸、SHA-256 和 ZIP CRC 检查；渲染错误为零。
- 英文界面通过中文残留检查；已逐张查看文字、布局和主要操作的可见性。
- 每张说明不超过 200 字符，文件均小于 50 MB；按[微软 MSIX 截图要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)准备。
- 在 Partner Center 对应语言的商店介绍中分别上传该语言目录里的 4 张 PNG，顺序为 01—04。ZIP、预览网页和清单不作为桌面截图上传。
- 当前正式 MSIX 不因截图更新而重新构建；认证仍由发布者自行提交。

## 重新生成

在仓库根目录运行：

```powershell
node scripts/capture-store-screenshots.mjs
```

可在命令末尾传入其他输出目录。脚本使用独立临时配置，阻止外部网络请求，不占用可见桌面；图片、说明、预览、校验清单与 ZIP 一并生成。
