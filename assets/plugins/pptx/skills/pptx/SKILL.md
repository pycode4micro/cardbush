---
name: pptx
description: 创建、读取和修改 PPTX 演示文稿与 POTX 模板，制作可编辑的文字、图表和版式，检查页面渲染结果。
license: Apache-2.0
conditional_reads:
  - references/runtime.md: 用内置工具创建或修改演示文稿
  - references/presentations.md: 处理现有模板、文本样式和图表
  - references/preview.md: 渲染或导出 PDF
---

# 演示文稿

使用本插件的 plugin_pptx_documents 服务，通过 MCP 搜索按需加载工具。PptxGenJS、JSZip 和 XML 组件已随 CardBush 配置。

用 inspect_document 按页查看文稿，记录页序、部件路径和 SHA-256；长内容有明确截断标记，精确编辑应在执行进程中读取完整部件。用 convert_document 转为新 PDF，再由 PDF 插件逐页渲染；转换需要本机 LibreOffice，可用性通过 document_environment 查询。

按 [运行接口](references/runtime.md) 调用 author_document 批量处理。新文稿使用可编辑对象；现有文稿保留未要求修改的母版、备注、图表和其他部件。PptxGenJS 用于新建；已有文件用 OOXML 定点编辑，不将提取文字后重建描述为无损编辑。

输出选择新路径并传入原件 SHA-256。结构可读不保证排版正确；正式交付前检查实际页面中的溢出、遮挡、替代字体和遗漏。没有渲染器时如实说明未进行视觉验收。
