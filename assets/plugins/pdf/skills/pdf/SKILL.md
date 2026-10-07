---
name: pdf
description: 读取、创建、编辑和渲染 PDF，提取页面文本、合并拆分页面、填写表单并检查输出。适用于 PDF 文件任务。
license: Apache-2.0
conditional_reads:
  - references/runtime.md: 制作、编辑、合并拆分或渲染 PDF
---

# PDF

使用本插件 plugin_pdf_documents 的工具，通过 MCP 搜索按需加载。PDF.js、pdf-lib、字体支持和页面渲染组件已内置，无需 Python 或 Office。

inspect_document 按页提取文本，按需继续 nextOffset。空文本可能是扫描页，不代表空白文件。用 render_pdf_page 逐页查看，避免整本内容和全部图片同时进入上下文。当前没有内置 OCR，不将扫描图像说成完整文字提取结果。

制作前读 [运行接口](references/runtime.md)。author_document 支持新建、页面复制、合并拆分、旋转与表单处理；输入使用副本，输出采用新路径。保留用户指定的页序和页码。

中文等非拉丁文字需要有效的可嵌入字体文件，使用用户提供或环境已有的字体；标准 PDF 字体不支持全部语言。交付前渲染检查缺字、溢出和表单外观。

覆盖文字、画黑框不等于安全脱敏。修改签名文件可能使签名失效，保留原件并说明；加密文件需要有效密码和明确支持的工具，不绕过保护。
