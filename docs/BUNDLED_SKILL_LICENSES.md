# 内置技能许可与来源整理

2026-09-28 整理了影响 SignPath 申请的四个技能。此记录描述本地源码的改动，不代表第三方签名服务已经批准，也不追溯改变旧版本的许可。

2026-10-05：CardBush 专属技能入口合并为 `cardbush-docs`。原 `cardbush-agent-deploy` 的部署和网络资料移入该技能的 references，许可保持 Apache-2.0。以下四项表格保留 9 月 28 日的历史处理记录；当前加载器不再发现独立的部署技能。

2026-10-07：XLSX、PPTX 技能迁入同名内置插件，新增 DOCX、PDF 插件。四个入口默认安装，共用 CardBush 原创的 `@cardbush/document-tools` 运行包，包含通过 npm 生产依赖分发的开源制作库；没有复制 OpenAI / Anthropic 的专有引擎或技能。原有 Python 参考仍为可选环境路径；日常制作无需 Python，LibreOffice 仍由用户环境提供。当前接口见 [文档插件](DOCUMENT_PLUGINS.md)，固定版本及许可见 [第三方说明](../packages/cardbush-document-tools/THIRD_PARTY_NOTICES.md)。下文关于外部库的描述属于迁移前的历史状态。

| 技能 | 本次处理 | 当前许可与范围 |
| --- | --- | --- |
| `cardbush-docs` | 保留 CardBush 文档与日历实现，统一技能入口许可；其首次提交是项目文档整合提交 `e092dd3` | Apache-2.0，许可全文随技能携带 |
| `cardbush-agent-deploy` | 保留 CardBush Agent 部署资料和调用边界，统一技能入口许可；其首次提交是 Agent/SSH 功能提交 `35cd542` | Apache-2.0，许可全文随技能携带 |
| `pptx` | 移出旧专有技能的整套文档、脚本、模板参考与随附 schema；独立编写新的技能入口和读写、预览参考 | CardBush 新编写内容为 Apache-2.0；通过外部安装的 python-pptx、PptxGenJS 或渲染器完成任务，不重新授权第三方实现 |
| `xlsx` | 移出旧专有技能的整套文档和脚本；独立编写入口、编辑/大文件参考和 LibreOffice 重算包装器 | CardBush 新编写内容为 Apache-2.0；openpyxl、LibreOffice 等外部工具保留各自许可 |

两个新办公技能保留 `pptx`、`xlsx` 名称及自动发现方式。旧技能目录中的代码、模板和 schema 未复制到替代版本，也没有把旧许可直接改成 Apache-2.0。这里的“独立编写”描述本次替代方式，不是第三方法律认证或完整的来源保证。

旧目录保留在本机被 Git 忽略的 `tmp/skill-license-archive-20260928/`，不在 `assets` 打包范围内。它们不会作为第三方技能被公开重新分发；此备份不是运行时回退路径。用户自行安装的技能和旧版本安装包均未修改，Git 历史也未重写。

## 能力与迁移

- PPTX：通过开源库创建、读取和编辑文稿，使用已有 Office/LibreOffice 渲染；没有渲染器时明确报告未进行视觉验证。旧的 `thumbnail.py`、Office XML 修补工具和原有版式指南不再随包提供。
- XLSX：保留开源工具读写、公式、格式、大文件流式处理及精度指导。旧的检查脚本由文档中的工具流程替代；没有声称新技能逐项实现旧脚本接口。
- `xlsx/scripts/recalc.py` 是新实现：`INPUT.xlsx OUTPUT.xlsx --timeout 60`。它写入独立的新文件，不再支持旧的原地修改接口；拒绝宏、外部数据连接及签名工作簿，保留失败前的原件。
- Python、openpyxl、python-pptx、LibreOffice 等依赖由使用环境提供，整理技能不会替用户全局安装这些工具。

## 验证与剩余范围

用 CardBush 实际技能加载器检查名称、自动发现、所有声明的参考路径和随附许可；保留原有图标契约测试。表格重算测试覆盖成功、超时、失败输出、错误/缺失缓存、并发修改和拒绝覆盖。实际 LibreOffice 计算另有可选集成测试，缺少引擎时明确跳过。

Codex 通用 `quick_validate.py` 不认识 CardBush 的 `conditional_reads` 扩展；这不是技能加载错误。两个 CardBush 专用技能通过其校验，两个办公技能的扩展由 CardBush 加载器与引用检查验证，未为通过通用检查删除产品支持的元数据。

此次未完成其余内置技能、npm 依赖和第三方原生二进制的完整来源/许可审计。不能把“四项已整理”写成“整个发行包均已满足 SignPath 条件”。旧公开版本仍包含旧材料；申请可用构建应来自后续明确审核、提交和发布的源码版本。

参考实现接口与外部依赖说明：

- [openpyxl](https://openpyxl.readthedocs.io/en/stable/)
- [python-pptx](https://python-pptx.readthedocs.io/en/latest/)
- [LibreOffice 命令行接口](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)
- [SignPath 项目条件](https://signpath.org/terms.html)
