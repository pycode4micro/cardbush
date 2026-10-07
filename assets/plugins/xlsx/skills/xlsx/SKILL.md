---
name: xlsx
description: 创建、读取、编辑和分析 XLSX 工作簿，处理公式、格式和图表。用于表格文件交付；实时操作已打开的 Excel 属于其他连接器。
license: Apache-2.0
conditional_reads:
  - references/runtime.md: 用内置工具创建或修改工作簿
  - references/large-data.md: 文件很大或涉及长编号与精度
  - references/workbooks.md: 检查公式和数据结果
---

# 电子表格

使用本插件的 plugin_xlsx_documents 服务，通过 MCP 搜索按需加载工具。ExcelJS 和 OOXML 组件已随 CardBush 配置，无需临时安装。

- inspect_document 按工作表、已填充行及列窗口读取，返回 SHA-256、nextOffset 和各行 nextColumn；按需继续，不将整本文件输出到对话。
- 创建或修改前读 [运行接口](references/runtime.md)，用 author_document 批量执行 JavaScript。输入使用副本，输出使用新路径；通过原件 SHA-256 检查并发变化。
- ExcelJS 不计算公式。需要重算时先用 document_environment 确认 LibreOffice，再用 convert_document 输出新 XLSX。缺少引擎时如实说明未重算，不把空缓存当作零。
- 视觉验收：转成 PDF，再由 PDF 插件逐页渲染检查。结构检查、公式无错误和业务结果正确是不同的验证。

沿用用户指定的表名、公式、格式和输入区域。长编号与前导零使用文本。宏、外部连接、签名和无法保真的复杂对象应保留原件并说明边界，不静默丢弃。

交付文件并报告实际完成的检查。原有 [recalc.py](scripts/recalc.py) 仍供已有 Python/LibreOffice 环境使用，优先使用插件工具。打包版的脚本若位于 app.asar，先读取并复制到工作区再由外部 Python 执行。
