---
name: xlsx
description: "Use when spreadsheet files are the main input or output: read, analyze, create, edit, repair, or convert .xlsx, .xlsm, .csv, and .tsv; inspect large or unknown workbooks safely; build formulas, tables, charts, models, trackers, and reports. Analysis may be delivered as an answer without creating a new spreadsheet."
description_zh: "用于读取、分析、创建、修改、修复或转换 Excel 工作簿、电子表格、.xlsx、.xlsm、.csv 和 .tsv；包括大型表格安全检查、公式、透视表、图表、模型、报表和数据清洗。仅分析表格时可以直接回答，无须额外生成文件。"
conditional_reads:
  - references/large-workbook-safety.md: The workbook or delimited file is large, unknown, slow, or precision-sensitive
  - references/workbook-design.md: Create or substantially redesign a reusable workbook, dashboard, tracker, or financial model
resource_quick_refs:
  - path: references/large-workbook-safety.md
    label: Memory-safe large spreadsheet workflow
    use_when: The workbook or delimited text file is large, unknown, slow to open, precision-sensitive, or could cause pandas/openpyxl memory pressure
    gives_you: A safe inspect-schema-stream workflow plus scripts/inspect_large_workbook.py and scripts/inspect_tabular_file.py
    not_for: Small known files where normal targeted reads are clearly safe
license: Proprietary. LICENSE.txt has complete terms
---

# Spreadsheets

Use pandas for targeted data analysis/preparation and openpyxl for workbook structure, formulas, styles, tables, charts, and comments. Use the local recalculation helper when formula results need updating. In mixed spreadsheet/presentation work, use the PPTX skill for the presentation.

Resolve bundled scripts and references relative to this `SKILL.md`, not the terminal's current directory. Replace `SKILL_DIR` in commands with that absolute directory, and use absolute input/output paths. Keep scratch files in the task workspace.

## Match the deliverable to the task

| Task | What to do |
|---|---|
| Inspect or analyze | Read the necessary data and answer the question. Do not create or modify a workbook unless the task needs it. |
| Targeted edit or repair | Inspect first, preserve the existing layout, sheet names, formulas, and template conventions, then verify the affected behavior. |
| Create a reusable workbook/model | Plan inputs, calculations, outputs, and checks. Use formulas for results that should update when inputs change. Read `references/workbook-design.md` for design and financial-model conventions. |
| Convert, extract, or clean data | Preserve types, precision, identifiers, row counts, and provenance. Static values are appropriate for CSV/TSV and fixed extracts; do not force Excel formulas or extra sheets. |

For analysis, existing formula caches may be missing or stale. Read the formulas or recalculate a task-local copy if fresh results are necessary; reading a file does not authorize overwriting it.

## Inspect before loading

For large, unknown, slow, or precision-sensitive sources, read [references/large-workbook-safety.md](references/large-workbook-safety.md) and start with the streaming inspector:

```text
python "SKILL_DIR/scripts/inspect_large_workbook.py" "INPUT.xlsx" --pretty
python "SKILL_DIR/scripts/inspect_tabular_file.py" "INPUT.csv" --pretty
```

Use the report to choose sheets, columns, and a schema before loading data. Do not load every sheet or use an eager alternative library merely to inspect headers.

- Keep identifiers, long integers, leading zeros, and high-precision values as raw strings until their meaning is known. Use Decimal or integer minor units for exact financial calculations.
- Stream or chunk the full relevant data for exact totals, averages, joins, and row counts. Track accepted/rejected rows and reconcile source and output counts.
- A sampled report or `scan_truncated=true` does not establish exact aggregates. Record coverage and unresolved macro, external-link, or formula issues.
- `openpyxl(read_only=True)` avoids a full cell model but can still load shared strings; use the inspector's limits and the large-workbook reference for very large files.

For known small inputs, targeted pandas reads or normal openpyxl editing are appropriate. Check only the dependencies needed for the route; never assume LibreOffice is installed:

```text
python -c "import openpyxl"
python -c "import pandas"
python "SKILL_DIR/scripts/recalc.py" --check-dependencies
```

The inspectors and recalculation validator use the Python standard library. Actual calculation requires LibreOffice. Use an existing or authorized project environment for missing dependencies; report a missing engine without claiming formulas were verified.

## Data and formula correctness

- For researched data, retain source title, URL/document/tool reference, date, and units. Use source columns for a new research dataset; preserve an existing template by using its source area, comments, or a linked Sources sheet. Distinguish unavailable data from zero.
- In reusable models, keep assumptions in labeled input cells and reference them. For example, use `=B5*(1+$B$6)` when B6 is an editable growth assumption.
- Use formulas for dynamic totals, ratios, and scenarios. Python calculations are appropriate for analysis, preprocessing, static snapshots, CSV/TSV, and user-requested fixed values.
- Check range endpoints, row offsets, copied references, units, blank/zero denominators, and unintended circular references. Quote sheet names when needed, e.g. `='Source Data'!B2`.
- Do not replace errors with zero just to make a workbook look clean. Fix the underlying reference/type problem or explicitly identify unresolved data.
- Use `data_only=False` when editing formulas. Saving a workbook opened with `data_only=True` can replace formulas with their cached values.
- Preserve VBA with `keep_vba=True` when using openpyxl on .xlsm, and verify with an engine that supports the workbook's macros/features. The bundled recalculator handles .xlsx only and does not execute embedded macros.
- Preserve existing template conventions over default formatting. Avoid merged cells inside sortable data tables, huge unused formatted ranges, and changes unrelated to the request.

## Save and verify the affected work

1. Save to the requested output path. Keep source material available when conversion or engine compatibility may affect features.
2. Reconcile headers, types, row counts, units, relevant calculations, and source references.
3. When formulas or their inputs changed, recalculate the output and inspect the result as below. A read-only extraction or a static CSV export does not need a formula engine.
4. Inspect user-facing sheets for clipped labels/numbers, widths, number formats, filters, frozen headers, and chart labels. Use rendered previews when available; state if visual verification was limited to structure.
5. Repair observed failures and repeat affected checks. Deliver the requested answer/file, without extra workbook scaffolding or scratch scripts unless useful.

## Formula recalculation

```text
python "SKILL_DIR/scripts/recalc.py" "OUTPUT.xlsx" 60
python "SKILL_DIR/scripts/recalc.py" "OUTPUT.xlsx" 60 --soffice "LIBREOFFICE_EXECUTABLE"
```

The optional timeout (default 30 seconds) bounds the LibreOffice process, including on Windows. `SOFFICE_PATH` also selects an executable. The helper uses a temporary copy and independent LibreOffice profile, runs calculate-all/save, requires a completion receipt, and streams actual formula caches and error cells from the saved XML. It checks source bytes again before publishing. It does not change the user's global LibreOffice macro configuration.

A successful process exit is insufficient. Literal explanatory text such as "#REF! means a broken reference" is not a cell error. An empty-string formula result is valid; an absent numeric formula cache is not.

| JSON status | Meaning and next action |
|---|---|
| `success` | Calculation/save were confirmed, formula locations preserved, caches present, and no error cells found; `modified=true`. Still verify business logic and relevant Excel feature compatibility. |
| `not_needed` | No formulas or error cells; original unchanged. |
| `errors_found` | Actual error cells found; inspect `error_summary` counts and sample locations. Original unchanged. |
| `incomplete` | Completion was not confirmed, formula locations changed, or caches remain absent. Original unchanged; inspect the reported reason. |
| `timeout` / `dependency_missing` | Calculation was not verified. Fix the execution condition or use an available compatible engine before claiming it passed. |
| `unsupported` | Non-XLSX or VBA-bearing workbook. Use a compatible Excel workflow. |
| `conflict` | Source bytes changed during calculation; the new source is preserved. |
| `error` | Execution, file validation, publishing, or cleanup failed. Inspect the reason and `modified` flag; cleanup can fail after a verified file was already published. |

The CLI exits nonzero for unsuccessful verification. Reports include exact totals and up to 20 example locations per error category; location lists are samples, not complete lists. External workbook sources are not refreshed, and any detected external links are reported as a limitation. LibreOffice may normalize formatting or Excel-specific features; a clean cache scan does not certify full Excel compatibility.
