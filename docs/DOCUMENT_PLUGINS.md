# 内置文档插件

CardBush 将表格、演示文稿、Word 和 PDF 作为四个默认安装的插件提供。在插件管理中可以分别启用、停用或卸载；停用后，对应技能与 MCP 工具一起移出当前能力目录。现有插件配置和用户自行安装的技能不会被覆盖。

| 插件 | 技能名 | 随包能力 | 可选引擎 |
| --- | --- | --- | --- |
| Spreadsheets | `xlsx:xlsx` | XLSX 创建、读取、编辑、格式及图表；ExcelJS + OOXML | LibreOffice 公式重算、导出 PDF |
| Presentations | `pptx:pptx` | PPTX 创建、渐进读取、OOXML 定点修改；PptxGenJS | LibreOffice 导出 PDF |
| Word Documents | `docx:docx` | DOCX 创建、读取和 OOXML 定点修改；旧 DOC 文本提取 | LibreOffice 将 DOC 转为 DOCX、导出 PDF |
| PDF | `pdf:pdf` | PDF 创建、合并、拆分、表单处理、文本读取、逐页 PNG 渲染 | 扫描件 OCR 需另接工具，不内置 OCR 引擎 |

四个插件共享 `@cardbush/document-tools` 的固定版本依赖，插件目录只提供独立入口与技能，避免重复分发引擎。桌面使用随包 Electron 的 Node 执行模式，独立 Agent 使用其 Node 主机；无需全局安装 Node、Python 或临时联网安装制作库。模型仍负责内容、版式、操作意图与验收，插件提供可调用的执行能力。

## 工具与工作流程

MCP 服务分别为 `plugin_xlsx_documents`、`plugin_pptx_documents`、`plugin_docx_documents`、`plugin_pdf_documents`，沿用现有工具搜索及命名空间。

1. 读取对应技能。`document_environment` 实际加载制作库，报告当前主机的可选 LibreOffice 路径。
2. `inspect_document` 返回一页内容及 SHA-256。XLSX 的 `offset` 按已填充行计数，`start_column` 从 1 开始；PPTX/PDF 按页，Word 按段落。跟随 `nextOffset` / `nextColumn` 渐进读取，显式读取可重复调用。
3. `author_document` 接收 JavaScript、输入文件和新输出路径。代码获得 `tools` 中的预配置库、输入副本及输出暂存路径，不把整份文档编码放入工具结果。
4. 写入后检查文件包/PDF 可读性、输入修订和输出是否已存在，再发布新文件。输出回执包含路径、大小、SHA-256 与实际完成的检查。
5. 有 LibreOffice 时用 `convert_document` 转换或重算；由 PDF 插件的 `render_pdf_page` 逐页渲染验收。没有引擎时返回 `document_engine_unavailable`，不伪装成已完成。

所有路径属于**当前执行主机**。独立 Agent 需要更新到包含共享运行包的版本；只同步插件目录到旧主机并不等于同步了运行时。SSH 上的文件也需要在实际可访问文件的执行环境中处理。

## 结果与执行边界

- 输入按原件修订进行校验，输出必须使用新路径；发布冲突不覆盖现有文件。取消、脚本失败或校验失败不会发布暂存结果。
- JavaScript 制作是普通代码执行，使用现有 MCP 权限与托管进程资源控制。临时目录用于工作文件隔离，**不是安全沙箱**，不能宣称脚本无法访问其他文件。
- 制作进程与模型运行进程分开。每个作业有超时、日志输出和内存预算；大文件可转用流式库工作流。Linux 的原生进程资源限制与其他托管命令保持相同的平台边界。
- XLSX 读取不触发计算，公式缓存可能为空或过期。ExcelJS 不计算公式；LibreOffice 重算检查错误、缺失缓存、工作表名称/顺序与公式位置，业务含义仍需核对。
- Office 写入检查文件包，不代表版式已经验收。复杂动画、嵌入对象、签名、宏及未知特性的修改不能保证无损。转换器拒绝带这些敏感部件或外部数据关系的 OOXML；普通超链接可保留。
- PPTX/DOCX 的已有文件编辑采用定点 OOXML 修改，库提供的新建 API 不能直接宣称支持所有原生 Office 编辑。旧 `.doc` 支持读取和转换，输出为 `.docx`；旧 `.ppt` / `.xls` 不由这组制作工具直接处理。
- PDF 使用 PDF.js + 原生 canvas 渲染；中文 PDF 制作需显式嵌入可用字体。覆盖色块不是可靠的内容删除，不自动声称完成脱敏。

LibreOffice 可由系统常见安装位置或 PATH 检出，也可在启动主机前设置 `CARDBUSH_SOFFICE` 为其可执行文件绝对路径。CardBush 不会自动安装该软件。

## 迁移与开发

原 `assets/skills/xlsx`、`assets/skills/pptx` 已移入对应 `assets/plugins/<id>/skills/<id>`，不再作为独立内置技能重复加载。原有 Python `recalc.py` 保留为备用资源；打包版本若需在外部 Python 执行，先将脚本复制到工作区，再使用其新文件输出接口。

- 插件声明：`assets/plugins/marketplace.json` 和各插件 `.codex-plugin/plugin.json` / `.mcp.json`。
- 共享实现：`packages/cardbush-document-tools/src`；`build:runtime` 编译装配，生产依赖进入桌面包及 Agent 构建。
- 回归：`npm run test:document-plugins`；技能/插件契约：`npm run test:product-skills`、`npm run test:product-plugins`；旧重算辅助脚本：`npm run test:xlsx-recalc`。
- CardBush 原创技能和运行包为 Apache-2.0；依赖保留原许可。来源说明见 [许可记录](BUNDLED_SKILL_LICENSES.md)。
