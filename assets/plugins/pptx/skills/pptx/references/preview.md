# 预览与 PDF 导出

## CardBush 内置预览

CardBush 桌面版有 PPTX 只读预览，不需要安装 Office 或 LibreOffice。有可用的原生界面工具时，打开会话中的实际 PPTX 文件链接或文件面板中的预览，再观察加载结果并逐页查看或截图。远端文件须先通过现有文件传输能力成为桌面可读取的文件，不把桌面能力假定为 SSH 执行主机的能力。

桌面主机的 `document_environment` 返回 `pngPreview` 能力。为 true 时，使用 `render_presentation` 输出实际 PPTX 页面：`path` 指向文稿，`output` 是新 PNG 路径，`pages` 为从 1 开始的页码，`width` 是每页宽度。单页默认输出第一页；例如 `pages: [1, 2, 3, 4]`、`columns: 2` 生成联系表。它与页面预览共用 PPTX / Chromium 引擎，保留文件的真实形状调整值和字体布局，不依赖 Office。

先生成并查看关键页的单页 PNG，再查看全稿联系表；重要内容、复杂形状和图片裁剪仍需放大检查。不要用手工重画的 HTML 页面、PPTX 内嵌缩略图或另一套 HTML 转换器制作“实际 PPTX 预览”，这些路径会隐藏几何和排版偏差。输出报告应注明是 CardBush 预览引擎；不能因此声称在 PowerPoint 中检查过。

远端主机若返回 `pngPreview: false`，可将文稿传到桌面主机再调用，或使用下面的 PDF 路径。当前 Browser Use 的集成浏览器导航只接受 HTTP(S)，不能直接打开内部 cardbush-file 预览协议。缺少相应工具或引擎时明确说明无法视觉复核，不杜撰已查看页面。

查看实际输出文件，包括关键内容页和全稿顺序。HTML 构图样稿可以辅助设计，但不能证明 PPTX 实际呈现一致。内置预览与 PowerPoint 可能在字体、动画和复杂对象上存在差异；记录使用的引擎与发现的限制。加载失败时根据实际错误选择其他渲染器，不能把空白或提取文本算作视觉验收。

## 原生应用与 PDF

使用已经可用的 PowerPoint、LibreOffice 或其他获准的渲染器。不要仅为预览去修改全系统文件关联或绕过系统应用控制。

LibreOffice 的[命令行参数](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)支持将文件转换为 PDF。通过进程参数数组调用实际可执行文件，将以下占位值换为绝对路径：

```text
soffice -env:UserInstallation=PROFILE_FILE_URI --headless --convert-to pdf --outdir OUTPUT_DIRECTORY INPUT.pptx
```

为每次转换使用独立的临时 profile，并用 `Path(...).resolve().as_uri()` 等标准方法构造 file URI。设置有限的进程超时，检查退出码以及本次新产生的 PDF；输出目录中旧的同名文件不能证明本次转换成功。Windows 优先使用可获取退出状态的 `soffice.com`，不要结束用户已打开的 Office 进程。

将 PDF 各页渲染为图片后查看实际页面，或使用原生演示软件检查。查看标题和正文是否超出文本框、图片是否变形、图例是否遮挡、字体是否替换，以及图表标签是否清楚。联系表适合检查全稿一致性，问题页面仍需放大检查。

PDF 转换不会覆盖 PPTX，但不同引擎可能呈现不同字体和动画效果。交付时说明使用的渲染器；没有可用渲染器时保留 PPTX，说明尚未进行视觉验证。
