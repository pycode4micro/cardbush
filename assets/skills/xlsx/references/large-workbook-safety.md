# Large Spreadsheet Safety

Use this reference when an `.xlsx`/`.xlsm` workbook or `.csv`/`.tsv` file may
be large, unknown, slow to open, precision-sensitive, or likely to cause memory
pressure.

## First Pass

Run the memory-safe inspector before using pandas or normal openpyxl mode:

```bash
python scripts/inspect_large_workbook.py input.xlsx --pretty
python scripts/inspect_tabular_file.py input.csv --pretty
```

For targeted inspection:

```bash
python scripts/inspect_large_workbook.py input.xlsx --sheet Transactions --sample-rows 30 --max-rows-scan 100000
python scripts/inspect_tabular_file.py input.tsv --delimiter "\t" --header yes --sample-rows 30 --max-rows-scan 100000
```

The XLSX script reads zip/XML parts directly, samples sheet rows, counts scanned
rows/cells/formulas/errors, resolves only sampled shared strings, and reports
whether scanning was truncated. The delimited-text script streams rows with the
standard csv module, keeps cell values as strings, profiles only bounded
columns, and flags precision risks before any typed conversion.

## Decision Rules

- Do not call `pd.read_excel(sheet_name=None)` on an unknown workbook.
- Do not call `pd.read_csv()` on a large or precision-sensitive delimited file
  before running `inspect_tabular_file.py`.
- Do not bypass a blocked eager read by switching to another direct full-file
  loader such as `polars.read_csv`, `numpy.loadtxt`, `numpy.genfromtxt`,
  `pyarrow.csv.read_csv`, `list(csv.reader(...))`, `Path.read_text()`,
  `Path.read_bytes()`, or `file.read()`.
- Do not use `openpyxl.load_workbook()` normal mode for large files just to
  inspect sheet names, dimensions, or headers.
- Use `openpyxl.load_workbook(read_only=True, data_only=True)` only for targeted
  read passes after the inspection step.
- Use `openpyxl.Workbook(write_only=True)` for large generated workbooks.
- Convert one sheet at a time to CSV/parquet when the analysis needs chunked
  processing. Preserve row counts, source sheet names, and data types.
- Prefer explicit `usecols`, `nrows`, `dtype`, and `parse_dates` when pandas is
  still appropriate.
- For CSV/TSV, prefer `pd.read_csv(..., chunksize=..., dtype=...)` or plain
  `csv.reader` streaming after schema selection. Preserve identifier-like
  values as strings.
- Keep formulas in Excel for delivered models, but compute validation summaries
  outside Excel when a deterministic audit is needed.

## Precision Contract

- Sampling is discovery only. It can identify shape, headers, representative
  values, and risk flags, but it cannot prove exact totals, averages, distinct
  counts, row counts, or financial conclusions.
- If the answer requires exactness, stream every required row once the schema is
  known. Report row counts scanned and reconcile source rows against output
  rows/check totals.
- Never let identifiers, account numbers, long integers, postal codes, security
  IDs, high-precision decimals, percentages, rates, or monetary values be
  inferred as float. Use raw strings, `decimal.Decimal`, or integer minor units.
- Preserve raw source values until validation passes. Normalized values should
  be written beside raw values or in a clearly named cleaned output.
- Treat `scan_truncated=true` as a stop sign for exact conclusions. Either rerun
  with a full streaming pass or state that the result is only a partial profile.

## Exact Streaming Pattern

Use this pattern when the user needs an exact answer from a large CSV/TSV or a
large worksheet converted to delimited text:

1. Inspect with the matching script and decide the schema.
2. Define required columns, raw types, normalization rules, and invalid-row
   handling before reading the full file.
3. Stream the full source row by row. Keep raw strings for identifiers and parse
   numeric facts with `Decimal` or integer minor units when precision matters.
4. Track `rows_seen`, `rows_used`, `rows_rejected`, and a small rejected-row
   sample with reasons. For joins or grouping, track unmatched keys.
5. Reconcile totals or row counts against source/control totals when available.
6. Only then write the final workbook/report, including a notes/checks area for
   schema choices, truncation status, rejected rows, and reconciliation results.

Do not publish exact-sounding language if any of those checks are incomplete.

## Field-First Processing

For large or unknown sources, the unit of work is a field/column, not the whole
file:

1. Inspect shape, headers, delimiter, sheet names, and representative rows.
2. Select only the fields needed for the requested answer.
3. Assign each selected field a raw type and normalized type. Keep identifiers
   raw as strings; use `Decimal` or integer minor units for money/rates.
4. Stream/chunk only those fields. Drop or ignore unneeded fields during the
   read step rather than loading them and discarding later.
5. Validate field-level assumptions with counts, rejected-row reasons, and
   reconciliation totals before presenting exact results.

If a runtime guard blocks a command, treat that as an instruction to follow this
field-first workflow. Do not try another full-file loading API to get around the
guard.

## Safe Workflow

1. Inspect workbook or delimited-text structure with the matching inspector.
2. Identify the minimum sheets and columns needed for the user goal.
3. Sample headers and representative rows before loading bulk data, but keep the
   sample out of final exact calculations.
4. Choose a memory strategy:
   - small targeted sheet: pandas with `usecols`/`dtype`
   - large sheet: read-only openpyxl streaming or convert to CSV first
   - large CSV/TSV: `csv.reader` streaming or pandas chunks with explicit dtype
   - huge source plus deliverable workbook: stream input, aggregate externally,
     write output with write-only openpyxl
5. For financial or exact analytical work, use `Decimal` or integer minor units
   for calculations and keep a row-count/check-total audit trail.
6. Record row counts and any truncation in the final answer or workbook notes.
7. Recalculate and scan formula errors with `scripts/recalc.py` when formulas are
   present.

## Stop Conditions

Stop and replan instead of continuing when:

- inspection shows required sheets are missing;
- `scan_truncated=true` and the requested answer requires exact full-sheet
  statistics;
- inspector risk flags show precision-sensitive columns but the calculation
  path would coerce them into floats;
- the workbook contains external links, macros, hidden sheets, or formulas that
  materially affect the answer and cannot be verified locally;
- memory-safe tooling cannot access the workbook as a valid Office zip or cannot
  decode the delimited text without replacement characters.
