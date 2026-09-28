# 预览与 PDF 导出

使用已经可用的 PowerPoint、LibreOffice 或其他获准的渲染器。不要仅为预览去修改全系统文件关联或绕过系统应用控制。

LibreOffice 的[命令行参数](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)支持将文件转换为 PDF。通过进程参数数组调用实际可执行文件，将以下占位值换为绝对路径：

```text
soffice -env:UserInstallation=PROFILE_FILE_URI --headless --convert-to pdf --outdir OUTPUT_DIRECTORY INPUT.pptx
```

为每次转换使用独立的临时 profile，并用 `Path(...).resolve().as_uri()` 等标准方法构造 file URI。设置有限的进程超时，检查退出码以及本次新产生的 PDF；输出目录中旧的同名文件不能证明本次转换成功。Windows 优先使用可获取退出状态的 `soffice.com`，不要结束用户已打开的 Office 进程。

将 PDF 各页渲染为图片后查看实际页面，或使用原生演示软件检查。查看标题和正文是否超出文本框、图片是否变形、图例是否遮挡、字体是否替换，以及图表标签是否清楚。联系表适合检查全稿一致性，问题页面仍需放大检查。

PDF 转换不会覆盖 PPTX，但不同引擎可能呈现不同字体和动画效果。交付时说明使用的渲染器；没有可用渲染器时保留 PPTX，说明尚未进行视觉验证。
