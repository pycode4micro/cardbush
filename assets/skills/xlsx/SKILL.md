---
name: xlsx
description: "Use this skill any time an Excel workbook or spreadsheet file is the primary input or output. This covers opening, reading, editing, fixing, or creating `.xlsx`, `.xlsm`, `.csv`, or `.tsv` files; safely inspecting very large or unknown workbooks without loading the full file into memory; building reusable Excel workbooks; adding formulas, pivot tables, sheets, formatting, charts, and cleanup logic; and converting between tabular file formats. Trigger especially when the user asks for an Excel workbook, spreadsheet, sheet, pivot-table deliverable, large XLSX analysis, memory-safe workbook processing, or references a spreadsheet file by name or path. The final deliverable must remain a spreadsheet file rather than a document, presentation, standalone app, database pipeline, or unrelated integration."
description_zh: "当 Excel 工作簿或电子表格文件是主要输入或输出时，使用此 skill。这包括打开、读取、编辑、修复或创建 `.xlsx`、`.xlsm`、`.csv`、`.tsv` 文件；对超大或未知工作簿做不整表进内存的安全检查；交付可复用的 Excel workbook；添加公式、透视表、工作表、格式、图表和清洗逻辑；以及在不同表格格式之间转换。尤其当用户明确提到 Excel、工作簿、电子表格、sheet、透视表、大型 XLSX 分析、内存安全处理，或直接提到某个表格文件名或路径，并希望对它进行处理或生成它时，就应触发。最终交付物必须保持为表格文件，而不是文档、演示稿、独立应用、数据库流水线或无关集成。"
conditional_reads:
  - references/large-workbook-safety.md: The workbook or delimited file is large, unknown, slow, or precision-sensitive
resource_quick_refs:
  - path: references/large-workbook-safety.md
    label: Memory-safe large spreadsheet workflow
    use_when: The workbook or delimited text file is large, unknown, slow to open, precision-sensitive, or could cause pandas/openpyxl memory pressure
    gives_you: A safe inspect-schema-stream workflow plus `scripts/inspect_large_workbook.py` and `scripts/inspect_tabular_file.py`
    not_for: Small known files where normal targeted reads are clearly safe
license: Proprietary. LICENSE.txt has complete terms
---

# Requirements for Outputs

## Bush Spreadsheet Quality Contract

Use the spreadsheet plugin's polish level as the bar, but keep this skill's Bush implementation path:

- **Implementation stays Bush-native**: pandas/openpyxl for workbook logic, LibreOffice recalculation through `scripts/recalc.py`, terminal execution for inspection, and local artifact checks. Do not switch to artifact-tool workbook APIs unless a separate Bush tool explicitly provides that path.
- **North Star**: the workbook should feel analyst-built, not exported. A reviewer should see the purpose, data lineage, assumptions, calculations, checks, and output view without reverse-engineering the file.
- **Workbook before grid**: do not dump a single raw sheet when the task implies analysis, modeling, tracking, or decision support. Plan the sheet map first.
- **Formula-driven by default**: calculated outputs remain formulas with references to inputs/source data. Python may prepare raw data, but Excel should own workbook calculations unless the user asks for static extracts.
- **Visual usability is part of correctness**: headers, formats, freeze panes, widths, filters/tables, charts, and error checks are deliverable requirements, not decoration.
- **Final answer discipline**: do not declare the workbook complete until formulas have been recalculated when needed, errors have been scanned, and the workbook structure has been inspected.

## Mixed-Skill Boundary

- This skill governs spreadsheet deliverables such as `.xlsx`, `.xlsm`, `.csv`, and `.tsv`.
- If the overall task also includes a PPT deliverable, **do not** use the Python-oriented examples in this skill to implement the PPT portion.
- In mixed `xlsx` + `pptx` tasks, the spreadsheet side may use the workbook libraries and scripts described here, but the presentation side must follow the `pptx` skill's implementation rules.
- If the spreadsheet is built from web, browser, document, or historical tool data, build from a fact ledger instead of freehand values. Each row-level metric must have a source URL/title/date or a cited tool-result record; when evidence is missing, write an explicit unavailable/unverified marker rather than inventing or hardcoding plausible values.
- For any source-backed, current-events, market, research, comparison, or investment-view spreadsheet, the primary data sheet must include machine-checkable source columns before delivery. Use explicit headers such as `Source Title`, `Source URL`, `Source Date`, and, when claims are interpretive, `Evidence/Excerpt`. Do this when designing the workbook, not as a late delivery repair.

## Task Mode and Workbook Profile Router

Before building or editing, classify the workbook lightly. This keeps the output coherent without replacing the user's request.

### Task Mode

| Mode | Use When | Extra Requirement |
|------|----------|-------------------|
| `create_from_scratch` | Build a new `.xlsx`, `.xlsm`, `.csv`, or `.tsv` deliverable | Plan the workbook map, formulas, checks, and presentation sheet before writing |
| `targeted_edit` | Modify an existing file, template, model, or report | Preserve existing conventions; inspect before changing; verify affected formulas |
| `audit_fix` | Diagnose formula errors, broken links, formatting, data quality, or model issues | Record findings, fix root causes, then rerun recalculation/error scans |
| `convert_extract` | Convert formats, split sheets, merge data, or extract tables | Preserve data types, source columns, and row counts; avoid adding unrelated analysis |

### Workbook Profile

Choose the closest profile and let it shape sheet structure and formatting:

| Profile | Best For | Default Sheet Pattern |
|---------|----------|-----------------------|
| `finance_model` | budgets, forecasts, valuations, scenarios, unit economics | `Summary`, `Assumptions`, `Model`, `Checks`, source/detail sheets |
| `operating_dashboard` | KPI packs, status reports, ops reviews | `Dashboard`, `Data`, `Calculations`, `Definitions`, optional `Checks` |
| `research_dataset` | sourced comparisons, market scans, vendor/product matrices | `Executive Summary`, `Data`, `Sources`, `Notes` |
| `tracker_template` | reusable planning, task, issue, hiring, sales, or inventory trackers | `Tracker`, `Lists`, `Instructions`, optional `Summary` |
| `data_cleaning` | messy CSV/XLSX cleanup, dedupe, normalization, reshaping | `Cleaned Data`, `Source Data`, `Transform Notes`, optional `Exceptions` |
| `existing_template` | user-provided model/report with established layout | preserve sheet names, style, formulas, and navigation unless asked otherwise |

If the task is simple extraction or conversion, do not force extra sheets. If the workbook supports a decision, include a summary or dashboard surface.

## Mandatory Bush XLSX Workflow

For non-trivial workbook tasks, follow this sequence:

1. Confirm `Task Mode` and `Workbook Profile`.
2. Inspect existing files before editing, including sheet names, dimensions, formulas, styles, and obvious hidden assumptions. For large or unknown `.xlsx`/`.xlsm`, read `references/large-workbook-safety.md` and run `python scripts/inspect_large_workbook.py <file>` before pandas or normal openpyxl mode. For large, unknown, or precision-sensitive `.csv`/`.tsv`, run `python scripts/inspect_tabular_file.py <file>` before pandas `read_csv`.
3. Plan the sheet map, source lineage, formula strategy, checks, and user-facing summary/dashboard surface.
4. Build or edit with pandas for data preparation and openpyxl for workbook structure, formulas, formatting, tables, charts, and comments.
5. Save the workbook and run `python scripts/recalc.py output.xlsx` whenever formulas are present or existing formulas may have changed.
6. Scan for formula errors, missing source columns when required, broken references, clipped labels, unreasonable column widths, and missing number formats.
7. Repair and rerun the affected verification step until the workbook is clean.
8. Deliver the final spreadsheet file; avoid exposing scratch scripts unless the user asks for implementation details.

## All Excel files

### Visual Direction

Choose one coherent visual language that fits the workbook's purpose. Treat these as
design directions, not rigid templates:

- **Executive or decision-support workbook**: restrained, polished, spacious, and
  presentation-ready, with a strong information hierarchy and a small number of
  emphasized takeaways.
- **Operational dashboard or recurring report**: compact, scan-first, neutral, and
  functional, with clear status cues and consistent repeated sections.
- **Financial model**: institutional and disciplined; dense information is acceptable
  when assumptions, calculations, outputs, and checks remain easy to distinguish.
- **Research or comparison workbook**: calm, analytical, and report-like, with readable
  text fields, visible sourcing, and emphasis on comparability rather than decoration.
- **Tracker or reusable template**: approachable and action-oriented, with obvious entry
  areas, progress states, exceptions, and lightweight instructions.
- **Data handoff or cleaned dataset**: utilitarian and quiet, prioritizing legibility,
  filtering, stable headers, and data types over visual flourish.

Apply the chosen style where it improves comprehension: workbook title and context,
summary areas, section and table headers, key outputs or KPI blocks, assumptions and
editable inputs, totals and subtotals, status or exception cells, charts, source notes,
and navigation cues. Do not style every cell equally; visual hierarchy should reveal
what to read, edit, verify, or act on first.

Use consistent typography, spacing, alignment, number formats, borders, and a restrained
color palette. Avoid ornamental gradients, excessive fills, heavy borders, decorative
charts, or many competing accent colors. Existing templates and explicit user branding
always take precedence over these directions.

### Table Presentation Standard

Every user-facing table must look intentionally designed, not like a raw DataFrame export:

- Establish a visible hierarchy for workbook title/context, section labels, table headers,
  body rows, subtotals, grand totals, editable inputs, calculated outputs, and checks. Do
  not give all cells the same visual weight.
- Prefer whitespace, alignment, and light horizontal separators over boxing every cell.
  On polished summary/model sheets, hide default gridlines when the layout supplies enough
  structure; retain gridlines on raw-data sheets when they improve navigation.
- Give headers clear but restrained contrast, consistent height, and one- or two-line
  wrapping. Avoid tall headers, saturated full-sheet fills, and merged cells inside data
  regions where sorting or filtering is expected.
- Left-align labels and narrative fields; right-align numeric values; keep dates, periods,
  and status fields consistent. Put units in headers and use one number format per measure
  across comparable rows or columns.
- Size columns from their content with sensible caps, wrap long text deliberately, and set
  row heights so no label or value is clipped. Freeze the identifying columns and header
  rows needed to keep large tables understandable while scrolling.
- Use banding only when it materially improves scanning of long tables. Reserve accent
  fills for decisions, inputs, exceptions, or key outputs; use semantic warning/success
  colors sparingly and never rely on color alone.
- Style subtotals and totals with spacing, weight, or a stronger top rule before adding a
  heavy fill. Keep blank separator rows intentional and avoid large unused formatted areas.
- Use Excel tables, filters, conditional formatting, and heatmaps only when they add real
  interaction or comparison value. Keep their style consistent with the rest of the sheet.
- Align summary cards, charts, and their source tables to a shared grid. Limit chart colors,
  remove visual clutter, label the decision-relevant values, and keep legends unambiguous.
- Before delivery, visually inspect every user-facing sheet at a normal zoom (and export or
  preview representative sheets when possible). Repair clipping, awkward wrapping, uneven
  spacing, accidental style spill, weak contrast, and inconsistent formats before calling
  the workbook complete.

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

### Visual and Usability Gates
- Use a clear workbook title area or summary sheet for decision-support workbooks.
- Freeze panes on data-heavy sheets and apply filters or Excel tables where users will scan rows.
- Set column widths deliberately; headers, key labels, and formatted numbers must not be clipped.
- Use consistent number/date/percentage/currency formats and include units in headers.
- Keep visual semantics restrained and functional: inputs, calculations, links, warnings, and outputs should be distinguishable without becoming noisy.
- Use charts, sparklines, conditional formatting, or KPI tiles only when they clarify the workbook's purpose. Do not add decorative charts with no analytical role.
- Include a `Checks` or clearly labeled validation area when formulas, joins, scenarios, or imported data can fail silently.

## Financial models

### Financial Model Visual Semantics

Unless the user or an existing template specifies otherwise, use familiar financial-model
semantics so editable assumptions, formulas, internal links, external links, important
outputs, and unresolved checks are easy to distinguish. Keep the scheme consistent and
subtle; do not let semantic coloring overwhelm the model or compete with its hierarchy.

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use $#,##0 format; ALWAYS specify units in headers ("Revenue ($mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "$#,##0;($#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+$B$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative numbers)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Company 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"
  - "Source: FactSet, 8/20/2025, Consensus Estimates Screen"

# XLSX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of an .xlsx file. You have different tools and workflows available for different tasks.

## Important Requirements

**LibreOffice Required for Formula Recalculation**: You can assume LibreOffice is installed for recalculating formula values using the `scripts/recalc.py` script. The script automatically configures LibreOffice on first run, including in sandboxed environments where Unix sockets are restricted (handled by `scripts/office/soffice.py`)

## Reading and analyzing data

### Large or unknown spreadsheet sources

Treat large XLSX/CSV/TSV files as fragile input. Do not load every sheet or a
whole delimited file into pandas just to inspect structure, headers, or data
types.

1. Run the streaming inspector:
   ```bash
   python scripts/inspect_large_workbook.py input.xlsx --pretty
   python scripts/inspect_tabular_file.py input.csv --pretty
   ```
2. Use the report to choose specific sheets, columns, row limits, and a column
   schema.
3. Use `openpyxl.load_workbook(read_only=True, data_only=True)` for targeted row
   streaming, or convert one sheet at a time to CSV/parquet for chunked pandas
   work.
4. Do not bypass the inspection step by switching to another eager loader such
   as polars, numpy, pyarrow, `list(csv.reader(...))`, `Path.read_text()`, or
   `file.read()`. Those still load too much data or can hide precision loss.
5. For precision-sensitive columns, keep raw strings until the schema is known.
   Do not infer identifiers, long integers, money, rates, or scientific notation
   into float. Use `Decimal`, integer minor units, or explicit `dtype=str`.
6. Record any `scan_truncated=true` or unresolved external/macro/formula issues
   in the final workbook notes or answer. A sampled inspection is not evidence
   for exact totals, averages, row counts, or financial conclusions.

See `references/large-workbook-safety.md` for stop conditions and memory-safe
decision rules.

### Data analysis with pandas
For data analysis, visualization, and basic operations, use **pandas** which provides powerful data manipulation capabilities:

```python
import pandas as pd

# Read Excel
df = pd.read_excel('file.xlsx')  # Default: first sheet
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # All sheets as dict

# Analyze
df.head()      # Preview data
df.info()      # Column info
df.describe()  # Statistics

# Write Excel
df.to_excel('output.xlsx', index=False)
```

For large, unknown, or precision-sensitive CSV/XLSX inputs, pandas is allowed
only after the inspection step has identified the required columns and schema.
Use chunked reads and explicit dtypes when needed; never let pandas silently
coerce identifiers, long integers, or high-precision decimals into floats.

For large files, think in fields rather than tables: inspect the headers, choose
only the columns required for the user goal, define raw/normalized types for
those columns, then stream or chunk the full file while tracking row counts and
rejected rows. Do not load a whole file into memory just because another library
can parse it.

## Excel File Workflows

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in Python and hardcoding them.** This ensures the spreadsheet remains dynamic and updateable.

### ❌ WRONG - Hardcoding Calculated Values
```python
# Bad: Calculating in Python and hardcoding result
total = df['Sales'].sum()
sheet['B10'] = total  # Hardcodes 5000

# Bad: Computing growth rate in Python
growth = (df.iloc[-1]['Revenue'] - df.iloc[0]['Revenue']) / df.iloc[0]['Revenue']
sheet['C5'] = growth  # Hardcodes 0.15

# Bad: Python calculation for average
avg = sum(values) / len(values)
sheet['D20'] = avg  # Hardcodes 42.5
```

### ✅ CORRECT - Using Excel Formulas
```python
# Good: Let Excel calculate the sum
sheet['B10'] = '=SUM(B2:B9)'

# Good: Growth rate as Excel formula
sheet['C5'] = '=(C4-C2)/C2'

# Good: Average using Excel function
sheet['D20'] = '=AVERAGE(D2:D19)'
```

This applies to ALL calculations - totals, percentages, ratios, differences, etc. The spreadsheet should be able to recalculate when source data changes.

## Common Workflow
1. **Choose tool**: pandas for data, openpyxl for formulas/formatting
2. **Create/Load**: Create new workbook or load existing file
3. **Modify**: Add/edit data, formulas, and formatting
4. **Save**: Write to file
5. **Recalculate formulas (MANDATORY IF USING FORMULAS)**: Use the scripts/recalc.py script
   ```bash
   python scripts/recalc.py output.xlsx
   ```
6. **Verify and fix any errors**: 
   - The script returns JSON with error details
   - If `status` is `errors_found`, check `error_summary` for specific error types and locations
   - Fix the identified errors and recalculate again
   - Common errors to fix:
     - `#REF!`: Invalid cell references
     - `#DIV/0!`: Division by zero
     - `#VALUE!`: Wrong data type in formula
     - `#NAME?`: Unrecognized formula name

### Creating new Excel files

```python
# Using openpyxl for formulas and formatting
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active

# Add data
sheet['A1'] = 'Hello'
sheet['B1'] = 'World'
sheet.append(['Row', 'of', 'data'])

# Add formula
sheet['B2'] = '=SUM(A1:A10)'

# Formatting
sheet['A1'].font = Font(bold=True, color='FF0000')
sheet['A1'].fill = PatternFill('solid', start_color='FFFF00')
sheet['A1'].alignment = Alignment(horizontal='center')

# Column width
sheet.column_dimensions['A'].width = 20

wb.save('output.xlsx')
```

### Editing existing Excel files

```python
# Using openpyxl to preserve formulas and formatting
from openpyxl import load_workbook

# Load existing file
wb = load_workbook('existing.xlsx')
sheet = wb.active  # or wb['SheetName'] for specific sheet

# Working with multiple sheets
for sheet_name in wb.sheetnames:
    sheet = wb[sheet_name]
    print(f"Sheet: {sheet_name}")

# Modify cells
sheet['A1'] = 'New Value'
sheet.insert_rows(2)  # Insert row at position 2
sheet.delete_cols(3)  # Delete column 3

# Add new sheet
new_sheet = wb.create_sheet('NewSheet')
new_sheet['A1'] = 'Data'

wb.save('modified.xlsx')
```

## Recalculating formulas

Excel files created or modified by openpyxl contain formulas as strings but not calculated values. Use the provided `scripts/recalc.py` script to recalculate formulas:

```bash
python scripts/recalc.py <excel_file> [timeout_seconds]
```

Example:
```bash
python scripts/recalc.py output.xlsx 30
```

The script:
- Automatically sets up LibreOffice macro on first run
- Recalculates all formulas in all sheets
- Scans ALL cells for Excel errors (#REF!, #DIV/0!, etc.)
- Returns JSON with detailed error locations and counts
- Works on both Linux and macOS

## Formula Verification Checklist

Quick checks to ensure formulas work correctly:

### Essential Verification
- [ ] **Test 2-3 sample references**: Verify they pull correct values before building full model
- [ ] **Column mapping**: Confirm Excel columns match (e.g., column 64 = BL, not BK)
- [ ] **Row offset**: Remember Excel rows are 1-indexed (DataFrame row 5 = Excel row 6)

### Common Pitfalls
- [ ] **NaN handling**: Check for null values with `pd.notna()`
- [ ] **Far-right columns**: FY data often in columns 50+ 
- [ ] **Multiple matches**: Search all occurrences, not just first
- [ ] **Division by zero**: Check denominators before using `/` in formulas (#DIV/0!)
- [ ] **Wrong references**: Verify all cell references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: Use correct format (Sheet1!A1) for linking sheets

### Formula Testing Strategy
- [ ] **Start small**: Test formulas on 2-3 cells before applying broadly
- [ ] **Verify dependencies**: Check all cells referenced in formulas exist
- [ ] **Test edge cases**: Include zero, negative, and very large values

### Interpreting scripts/recalc.py Output
The script returns JSON with error details:
```json
{
  "status": "success",           // or "errors_found"
  "total_errors": 0,              // Total error count
  "total_formulas": 42,           // Number of formulas in file
  "error_summary": {              // Only present if errors found
    "#REF!": {
      "count": 2,
      "locations": ["Sheet1!B5", "Sheet1!C10"]
    }
  }
}
```

## Best Practices

### Library Selection
- **pandas**: Best for data analysis, bulk operations, and simple data export
- **openpyxl**: Best for complex formatting, formulas, and Excel-specific features

### Working with openpyxl
- Cell indices are 1-based (row=1, column=1 refers to cell A1)
- Use `data_only=True` to read calculated values: `load_workbook('file.xlsx', data_only=True)`
- **Warning**: If opened with `data_only=True` and saved, formulas are replaced with values and permanently lost
- For large files: Use `read_only=True` for reading or `write_only=True` for writing
- Formulas are preserved but not evaluated - use scripts/recalc.py to update values

### Working with pandas
- Specify data types to avoid inference issues: `pd.read_excel('file.xlsx', dtype={'id': str})`
- For large files, read specific columns: `pd.read_excel('file.xlsx', usecols=['A', 'C', 'E'])`
- Handle dates properly: `pd.read_excel('file.xlsx', parse_dates=['date_column'])`

## Code Style Guidelines
**IMPORTANT**: When generating Python code for Excel operations:
- Write minimal, concise Python code without unnecessary comments
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements

**For Excel files themselves**:
- Add comments to cells with complex formulas or important assumptions
- Document data sources for hardcoded values
- Include notes for key calculations and model sections
