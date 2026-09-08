---
name: pptx
description: "Use for creating, reading, extracting, editing, combining, or splitting PowerPoint .pptx files and presentation deliverables, including slide decks, templates, layouts, speaker notes, and comments."
description_zh: "用于创建、读取、分析、修改、合并或拆分 PPT、PowerPoint 演示文稿和幻灯片文件，或抽取 .pptx 内容；包括模板、版式、讲者备注和评论。"
conditional_reads:
  - pptxgenjs.md: Generate a new deck or regenerate slides with PptxGenJS; read the API sections needed for the work
  - editing.md: Edit existing or template-based decks using their existing XML structure
  - references/pptx-layout-constraints.md: Design or change slide geometry; use the sections for the selected layout and actual page size
  - references/pptx-design-patterns.md: Choose a visual direction or layout for a new deck or substantial redesign; consult relevant patterns
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX

Create editable presentations with PptxGenJS. Preserve existing template structure through the XML workflow in [editing.md](editing.md) when appropriate. Spreadsheet work in a mixed task uses its own skill; Python spreadsheet examples do not replace the PPTX generation engine.

Resolve bundled scripts and references relative to this `SKILL.md`, not the terminal's current directory. Replace `SKILL_DIR` in examples with that absolute directory. Keep source, intermediate PDFs, extracted assets, and slide renders in the task workspace.

## Choose the work that the request needs

| Request | Workflow and references |
|---|---|
| Read, summarize, or extract content | Extract text; inspect specific slides visually when layout or imagery matters. No generation guide or redesign plan needed. |
| Targeted edit, localization, combine, or split | Inspect the source and read `editing.md`. Preserve its layout, theme, notes, and unaffected slides; verify changed slides and affected neighbors. |
| Create a new deck | Use `pptxgenjs.md`; decide the audience, main argument, evidence, and slide order. Consult layout constraints for the chosen geometry. |
| Substantial redesign | Inspect the existing deck, preserve required content and branding, then use the creation workflow and relevant design patterns. |

Design notes can stay brief and local to the working source. The design-pattern catalogue is a set of options, not a required template or a reason to read every pattern. User page count, branding, and existing templates take precedence over default aesthetic suggestions.

## Check the actual environment

Use the task's Node/Python environment and check only dependencies needed for the selected route:

```text
node -e "console.log(require.resolve('pptxgenjs'))"
python -m markitdown --help
python "SKILL_DIR/scripts/thumbnail.py" --check-dependencies
python "SKILL_DIR/scripts/office/soffice.py" --check-dependencies
pdftoppm -h
```

- PptxGenJS is required for new or regenerated PPTX. Install missing JavaScript dependencies in the authorized project environment; do not assume a global npm package is resolvable from the deck source.
- Text extraction uses `markitdown[pptx]`. Thumbnail generation also needs Pillow and defusedxml.
- Rendering uses LibreOffice and Poppler. The LibreOffice helper discovers platform-specific installations, supports `SOFFICE_PATH`, and bounds each invocation.
- If a required dependency is unavailable, state the exact missing capability and which verification remains incomplete. Do not claim a rendered QA pass based on a successful file write.

## Evidence and content

For researched decks, keep a compact source ledger with source title, URL or local document/tool reference, date, and the supported claim. Every sourced number, trend, quotation, and chart value must trace to evidence. Fetch or read missing evidence within the current task when possible; there is no separate read-stage/write-stage restriction. Mark unresolved gaps instead of filling them with plausible values.

Before laying out a new deck, settle its main argument and the role of each slide. Match the proof object to the content: a chart for numerical comparison, a diagram for relationships, an image for visual evidence, or readable text when that is sufficient. Choose a coherent palette, typography, spacing, and repeated visual language. A short outline is enough for a small deck; a routing table helps when the deck is complex.

Use a claim-oriented title where appropriate. Keep units, dates, labels, legends, and source notes readable. Treat illustrations and conceptual diagrams as illustrations, not measured evidence.

## Build and inspect

1. Inspect source files and the actual slide size before changing them.
2. Generate or edit using the selected route. Start with one source file and shared helpers; split into modules when it improves maintainability. Patch that source as needed.
3. Generate the final PPTX, extract its text, and compare content with the request and sources.
4. Render new/changed slides. Inspect actual slide images for clipping, overlap, wrapping, contrast, margins, label readability, and placeholder text. For a new deck, inspect the whole deck and its contact sheet; for a local edit, inspect affected slides and neighbors.
5. Fix observed defects and rerun the affected checks. A clean first pass can finish without an artificial fix cycle. Adjust a design plan when the rendered evidence supports a better solution, while preserving the user's requirements.
6. Deliver the PPTX with a clear file link and any material verification limitation.

## Commands

Replace `INPUT`, `OUTPUT`, `SCRATCH`, and `SKILL_DIR` with absolute paths. Create the scratch/output directories before running commands.

```text
python -m markitdown "INPUT.pptx"
python "SKILL_DIR/scripts/thumbnail.py" "INPUT.pptx" "SCRATCH/contact-sheet"
python "SKILL_DIR/scripts/office/unpack.py" "INPUT.pptx" "SCRATCH/unpacked"
```

For full-resolution visual inspection, render into a task-specific directory using a separate LibreOffice profile:

```text
python "SKILL_DIR/scripts/office/soffice.py" "-env:UserInstallation=PROFILE_FILE_URI" --headless --convert-to pdf --outdir "SCRATCH/render-1" "OUTPUT.pptx"
pdftoppm -jpeg -r 150 "SCRATCH/render-1/OUTPUT.pdf" "SCRATCH/render-1/slide"
```

`PROFILE_FILE_URI` is an absolute file URI for a scratch profile directory, e.g. the result of `Path(profile).resolve().as_uri()`. Use a new render directory for a changed deck so stale images cannot be mistaken for the latest output. List the files actually created and inspect those paths. To inspect a particular slide, Poppler supports `-f N -l N`.

Check extracted text for missing claims, wrong order, stale dates, broken labels, and leftover template placeholders. Layout checks require viewing rendered images; text extraction alone does not establish visual quality.
