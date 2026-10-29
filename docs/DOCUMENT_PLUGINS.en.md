# Built-in document plugins

[English](DOCUMENT_PLUGINS.en.md) · [简体中文](DOCUMENT_PLUGINS.md)

[中文](DOCUMENT_PLUGINS.en.md) | [Documentation](README.md)

CardBush installs four separate plugins for spreadsheets, presentations, Word and PDF by default. Enable, disable or uninstall each in plugin management. Disabling removes its Skills and MCP tools from the active catalog together. Existing plugin configuration and user-installed Skills are preserved.

| Plugin | Skill | Bundled capabilities | Optional engine |
| --- | --- | --- | --- |
| Spreadsheets | `xlsx:xlsx` | XLSX creation, reading, edits, formatting/charts with ExcelJS + OOXML | LibreOffice formula recalculation/PDF export |
| Presentations | `pptx:pptx` | PPTX creation, progressive reading, targeted OOXML edits with PptxGenJS | LibreOffice PDF export |
| Word Documents | `docx:docx` | DOCX creation/reading/targeted OOXML edits; legacy DOC text extraction | LibreOffice DOC-to-DOCX/PDF conversion |
| PDF | `pdf:pdf` | Creation, merge/split, forms, text reading and page PNG rendering | Scanned-document OCR requires another tool; no OCR engine is bundled |

They share pinned dependencies in `@cardbush/document-tools`; plugin directories contain separate entry points/Skills without duplicating engines. Desktop uses bundled Electron's Node mode; standalone Agent uses its Node host. No global Node/Python or temporary online authoring-library installation is needed for desktop document operations. The model remains responsible for content, layout, intent and acceptance; plugins provide execution.

## Tools and workflow

MCP servers are `plugin_xlsx_documents`, `plugin_pptx_documents`, `plugin_docx_documents` and `plugin_pdf_documents`, discovered through existing namespaces/search.

1. Read the relevant Skill. `document_environment` loads actual authoring libraries and reports optional LibreOffice availability on this host.
2. `inspect_document` returns a content page and SHA-256. XLSX `offset` counts populated rows and `start_column` is one-based; PPTX/PDF use pages and Word uses paragraphs. Follow `nextOffset`/`nextColumn` progressively; explicit reads may be repeated.
3. `author_document` accepts JavaScript, input files and a new output path. Code receives configured libraries through `tools`, input copies and a staging output path, without encoding whole documents into receipts.
4. Before publishing, validate the file package/PDF, input revision and absence of the target. The receipt includes path, size, SHA-256 and checks actually performed.
5. With LibreOffice available, `convert_document` converts/recalculates; PDF's `render_pdf_page` supports page-by-page visual review. Missing engines return `document_engine_unavailable`, not fabricated completion.

Paths belong to the **current execution host**. Standalone Agents need a version containing the shared runtime package; copying plugin directories alone to an old host is insufficient. SSH files must likewise be handled where they are accessible.

## Results and execution boundaries

- Inputs are revision-checked; outputs require new paths. Publication conflicts never overwrite files. Cancellation, script failure or validation failure does not publish staging outputs.
- Authoring JavaScript is ordinary code execution under existing MCP permissions and managed-process resource controls. Temporary directories isolate working files; **they are not a security sandbox** and do not prove scripts cannot access other files.
- Authoring runs separately from the model process, with timeouts, output logs and memory budgets. Large files can use streaming libraries. Linux follows the same native resource-enforcement limitations as other managed commands.
- Reading XLSX does not calculate formulas, and cached values may be missing/stale. ExcelJS does not calculate. LibreOffice recalculation checks errors, missing caches, sheet names/order and formula positions; business meaning still needs review.
- Office package validation is not visual acceptance. Complex animation, embedded objects, signatures, macros and unknown features cannot be guaranteed lossless. Converters reject OOXML with these sensitive parts or external data relationships; ordinary hyperlinks can remain.
- Existing PPTX/DOCX edits use targeted OOXML changes. New-document APIs do not imply arbitrary native Office editing. Legacy `.doc` supports reading/conversion with `.docx` output; these authoring tools do not directly process legacy `.ppt`/`.xls`.
- PDF uses PDF.js and native canvas. Embed an available font explicitly for Chinese PDF creation. Covering text with a rectangle is not reliable deletion/redaction.

LibreOffice is discovered in common installation directories/PATH, or via an absolute `CARDBUSH_SOFFICE` executable path set before host startup. CardBush does not install it automatically.

## Migration and development

Old `assets/skills/xlsx` and `assets/skills/pptx` moved to `assets/plugins/<id>/skills/<id>` and are no longer duplicated as standalone bundled Skills. The Python `recalc.py` remains an optional reference. Copy it to the workspace before external Python execution from a packaged install, and use its new-output-file interface.

- Manifests: `assets/plugins/marketplace.json`, plugin `.codex-plugin/plugin.json` and `.mcp.json`.
- Shared implementation: `packages/cardbush-document-tools/src`; `build:runtime` assembles it, and production dependencies ship in desktop/Agent builds.
- Tests: `npm run test:document-plugins`, `npm run test:product-skills`, `npm run test:product-plugins`, and `npm run test:xlsx-recalc` for the optional helper.
- Original CardBush Skills/runtime code use Apache-2.0; dependencies retain their licenses. See the original [license migration record](BUNDLED_SKILL_LICENSES.md) and [third-party notices](../packages/cardbush-document-tools/THIRD_PARTY_NOTICES.md).
