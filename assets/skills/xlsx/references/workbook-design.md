# Workbook design

Use this reference when building or substantially redesigning a reusable workbook.
A local edit preserves its template; a read-only analysis or flat-file conversion
does not need this design workflow.

## Structure that fits the work

| Purpose | Useful structure; add only what the task needs |
|---|---|
| Forecast, budget, scenario, valuation | Summary, Assumptions, Model, Checks, source detail |
| Operational dashboard | Dashboard, Data, Definitions, calculations/checks where useful |
| Sourced comparison | Data with source columns, Sources, summary if it supports a decision |
| Reusable tracker | Tracker, validated lists, brief instructions, optional summary |
| Data cleaning | Cleaned Data, transformation notes, rejected/exception rows |

Separate editable inputs from calculations and outputs. Make the workbook's
purpose, reporting period, units, and important assumptions visible. Keep raw
source data traceable rather than mixing it invisibly with manual adjustments.
Do not add a summary/dashboard when a simple extract is the requested deliverable.

## Tables and visual hierarchy

- Give titles, headers, body rows, subtotals, outputs, and checks distinct but
  restrained weight. Use spacing and alignment before heavy fills and borders.
- Left-align labels, right-align numeric values, and use consistent formats
  across comparable measures. Include units and currencies in headers.
- Set column widths with sensible caps; wrap long text and adjust row heights.
  Inspect rendered sheets when available to verify that labels and formatted
  numbers fit at normal zoom.
- Freeze headers and identifying columns needed for navigation. Add filters or
  Excel tables for sortable datasets; avoid merged cells inside those regions.
- Use subtle banding only when it improves scanning. Reserve accent colors for
  inputs, important outputs, and exceptions; never communicate status by color
  alone.
- Hide gridlines on polished summaries when the layout provides structure;
  retain them on data sheets when helpful.
- Use one coherent typography, spacing, number-format, and color system.
  Existing templates, branding, currency, and locale take precedence.
- Use charts only to clarify a comparison, trend, distribution, or relationship.
  Align charts with their source tables, label units, and keep legends readable.
- Avoid formatting entire unused columns/rows. Large empty styled areas increase
  file size and can mislead workbook dimension scans.

## Model behavior

In reusable models, reference labeled assumptions and source cells so outputs
update when inputs change. Make manual inputs, formulas, internal links, external
links, and checks easy to distinguish through consistent formatting and labels.

Keep a Checks area when joins, scenarios, imported data, or formulas can fail
silently. Useful checks include source/output row reconciliation, balance
identities, unmatched IDs, duplicated keys, totals versus detail, and invalid
denominators. Choose checks tied to the actual model; do not add decorative
"OK" cells without a meaningful condition.

Test representative formulas before filling a large range. Verify absolute and
relative references, period alignment, range endpoints, missing data, zero and
negative values, and circular dependencies. A successful formula-engine run
does not establish that the financial or analytical model is correct.

## Financial conventions

Follow the user's template first. For a new model:

- Put growth rates, margins, tax rates, multiples, and other editable assumptions
  in labeled cells, with sources or an explicit assumption label.
- Keep years ungrouped, such as 2026. Show currency and scale in headers, using
  the actual currency and locale rather than assuming USD.
- Use consistent precision for each measure. One decimal for percentages and
  multiples is a useful default; preserve more precision when the task needs it.
- Accounting-style parentheses for negatives and dashes for zero are options,
  not changes to the underlying numeric value. Preserve meaningful distinctions
  among zero, blank, and unavailable.
- Attach provenance to researched hardcodes: source document/system, date, page
  or record, and URL where available. A source may live in a cell comment or
  linked source area rather than repeating a long citation in every row.
- Use exact decimal or integer-minor-unit preparation where rounding matters,
  and make rounding assumptions visible.

## Library details

- openpyxl cell coordinates are 1-based. Load formulas with `data_only=False`
  when editing; `data_only=True` reads caches and must not be used for a
  formula-preserving save.
- openpyxl preserves formulas but does not calculate them. Use the recalculation
  workflow in `../SKILL.md` after changing formulas or their inputs.
- Use read-only/write-only modes when appropriate for large workbooks, after
  inspection. Do not convert a read-only row iterator into a full list.
- With pandas, specify the selected sheet/columns and explicit types. For exact
  decimal text, avoid an intermediate floating-point conversion.
- Document unusual formulas, key assumptions, and unresolved compatibility
  issues where the next workbook user can find them.
