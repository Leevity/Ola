---
name: xlsx
description: Create, edit, inspect, and validate spreadsheet files while preserving formulas and formatting. Use for XLSX, XLSM, CSV, or TSV analysis, formula authoring, charts, data visualization, workbook repair, and recalculation workflows.
---

# Spreadsheet workflows

Use Python with `openpyxl` for XLSX/XLSM and the standard `csv` module or pandas for delimited data. Preserve the source workbook unless the user explicitly asks for in-place replacement.

## Inspect before editing

1. Load the workbook with formulas visible (`data_only=False`).
2. Record sheet names, dimensions, hidden sheets, merged ranges, tables, charts, validations, and named ranges that matter.
3. Detect macros before saving. For XLSM, use `keep_vba=True` and retain the `.xlsm` extension.
4. Identify formula cells and external links before changing structure.
5. Decide whether recalculation is required.

```python
from openpyxl import load_workbook

wb = load_workbook("input.xlsx", data_only=False)
for ws in wb.worksheets:
    print(ws.title, ws.max_row, ws.max_column)
```

## Make focused edits

- Modify only requested sheets and ranges.
- Copy styles with `copy.copy`; do not reuse mutable style objects directly.
- Prefer formulas to pasted totals when the workbook is intended to remain live.
- Keep formulas locale-neutral and use commas as separators.
- Preserve tables, filters, freeze panes, validations, print areas, and merged cells unless intentionally changing them.
- Do not silently convert formulas to values.
- Avoid whole-column scans for large sheets; derive the active region first.

Example formula:

```python
ws["D2"] = "=IFERROR(B2/C2,0)"
ws["D2"].number_format = "0.0%"
```

## Create a workbook

Use clear sheet names, frozen headers, readable widths, filters, and appropriate number formats. Separate raw data, calculations, and presentation when the workbook is more than a simple table. Add charts only when they make the requested relationship clearer.

For CSV or TSV output, remember that formulas, styles, multiple sheets, charts, and types are not preserved. Make that loss explicit before conversion.

## Recalculate formulas

`openpyxl` writes formulas but does not calculate them. If cached values must be current, run the bundled recalculation helper:

```bash
python recalc.py output.xlsx
```

This requires LibreOffice. If it is unavailable, set workbook calculation mode to automatic, preserve formulas, and tell the user that values will refresh when opened in a spreadsheet application.

## Validate the result

1. Reopen the saved workbook with `data_only=False` and confirm it parses.
2. Confirm expected sheets, dimensions, formulas, formats, and data validations.
3. Reopen with `data_only=True` after recalculation when cached values matter.
4. Check formulas for `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, and broken external references.
5. Verify that macro-enabled files still contain VBA content.
6. For presentation-heavy workbooks, render or open the changed sheets and inspect them visually.

```python
from openpyxl import load_workbook

wb = load_workbook("output.xlsx", data_only=False)
assert "Summary" in wb.sheetnames
assert wb["Summary"]["D2"].value.startswith("=")
```

## Safety and fidelity

- Treat formulas, external links, and macros as untrusted content.
- Never execute workbook macros.
- Keep credentials and personal data out of logs and generated helper files.
- Preserve date, currency, percentage, and identifier semantics.
- Do not infer missing business values unless the user provides a rule.
- Use a new output path for repair operations so the original remains recoverable.

## Deliverables

Return the workbook path, the sheets or ranges changed, whether formulas were recalculated, and any fidelity limitations such as unsupported macros, external links, or chart rendering.
