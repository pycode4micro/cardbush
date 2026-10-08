---
name: pptx
description: 创建、读取和修改 PPTX 演示文稿与 POTX 模板，根据内容和参考形成视觉方向，制作可编辑页面并检查实际渲染。
license: Apache-2.0
conditional_reads:
  - references/design.md: 制作新稿、改进审美或调整页面布局
  - references/runtime.md: 用内置工具创建或修改演示文稿
  - references/presentations.md: 处理现有模板、文本样式和图表
  - references/preview.md: 视觉复核、内置预览或导出 PDF
---

# 演示文稿

使用本插件的 plugin_pptx_documents 服务，通过 MCP 搜索按需加载工具。PptxGenJS、JSZip 和 XML 组件已随 CardBush 配置。

新稿或视觉改稿先读 [设计指导](references/design.md)。根据受众、内容和用户参考选择视觉方向，再用有代表性的页面验证后扩展。指导提供判断依据，具体配色、字体、图像和构图由模型选择；用户的模板与设计要求优先。普通文字修订不需要重新设计整稿。

插件提供文件检查、自由编程制作和可选转换，不提供固定的成稿模板。可编辑文字、图片、图表、表格和形状可以自由组合；可编辑不等于只能用几何图形。不要把“科技”自动转换为深蓝底、青紫色线条和重复卡片。

用 inspect_document 按页查看文稿，记录页序、部件路径和 SHA-256；长内容有明确截断标记，精确编辑应在执行进程中读取完整部件。

按 [运行接口](references/runtime.md) 调用 author_document 批量处理。新文稿使用可编辑对象；现有文稿保留未要求修改的母版、备注、图表和其他部件。PptxGenJS 用于新建；已有文件用 OOXML 定点编辑，不将提取文字后重建描述为无损编辑。

输出选择新路径；修改文件时传入原件 SHA-256。按 [预览指导](references/preview.md) 复核实际生成的 PPTX。CardBush 内置预览不依赖 LibreOffice；转 PDF 才需要检查转换引擎。检查阅读层级、页面节奏以及溢出、遮挡、替代字体和遗漏，发现问题后修改并重新查看。结构可读不保证排版正确；无法查看成品时如实说明未进行视觉验收。
