# Document runtime dependencies

CardBush's document runtime, plugin manifests and skills are independently authored under Apache-2.0. This package does not include OpenAI Artifact Tool or Anthropic's proprietary Office skill implementations.

These libraries are distributed through production npm dependencies. Their unmodified license files and transitive dependency notices remain in `node_modules`; `package-lock.json` records exact versions and integrity. This list describes direct document dependencies, not a replacement for their license texts.

| Library | Pinned version | License | Source |
| --- | --- | --- | --- |
| ExcelJS | 4.4.0 | MIT | https://github.com/exceljs/exceljs |
| PptxGenJS | 4.0.1 | MIT | https://github.com/gitbrent/PptxGenJS |
| docx | 9.9.0 | MIT | https://github.com/dolanmiu/docx |
| word-extractor | 1.0.4 | MIT | https://github.com/morungos/node-word-extractor |
| pdf-lib | 1.17.1 | MIT | https://github.com/Hopding/pdf-lib |
| @pdf-lib/fontkit | 1.1.1 | MIT | https://github.com/Hopding/fontkit |
| pdfjs-dist | 5.4.296 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| @napi-rs/canvas | 0.1.80 | MIT | https://github.com/Brooooooklyn/canvas |
| JSZip | 3.10.1 | MIT (selected from MIT OR GPL-3.0-or-later) | https://github.com/Stuk/jszip |
| @xmldom/xmldom | 0.9.12 | MIT | https://github.com/xmldom/xmldom |

The MCP SDK and Zod retain their MIT licenses. Native canvas also uses Skia and other third-party components; its npm platform archive contains a compiled binding and ICU data, not a complete source/license audit. Refer to its upstream source for component notices. LibreOffice is an optional separately installed program; it is not redistributed by this document runtime. Fonts selected by the user retain their own embedding and redistribution conditions.
