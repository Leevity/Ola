---
name: pdf
description: Read, create, inspect, render, and validate PDF files. Use for extracting text or tables, generating PDFs, merging or splitting pages, filling forms, adding annotations, and checking layout or bounding boxes.
---

# PDF workflows

Work from the requested outcome and preserve the source file unless the user explicitly asks to replace it.

## Choose the workflow

- Extract text or tables: start with `pdftotext`, `pdfinfo`, or Python `pdfplumber`.
- Inspect visual layout: render relevant pages to images and inspect them.
- Create a PDF: use ReportLab for deterministic layout, then render and verify it.
- Merge, split, rotate, encrypt, or inspect metadata: use `pypdf`.
- Fill a form: inspect whether the PDF contains AcroForm fields, then follow `forms.md`.
- Diagnose clipping or overlap: run `scripts/check_bounding_boxes.py` and inspect rendered pages.

Read `reference.md` only when the task needs detailed library examples. Read `forms.md` only for form-filling work.

## Inspect before editing

1. Identify the page count, page sizes, encryption state, and whether text is extractable.
2. Render only the pages needed for visual inspection.
3. Determine whether the document is digitally generated, scanned, or a hybrid.
4. For scanned pages, use OCR and keep confidence limitations explicit.
5. Save outputs to a new path unless replacement is explicitly requested.

Useful commands:

```bash
pdfinfo input.pdf
pdftotext -layout input.pdf output.txt
pdftoppm -png -r 150 input.pdf /tmp/pdf-page
python scripts/convert_pdf_to_images.py input.pdf --output_dir /tmp/pdf-pages
```

## Extract content

Prefer `pdftotext -layout` for ordinary text. Use `pdfplumber` when page coordinates, tables, or per-page filtering matter. OCR only pages without a usable text layer.

For tables:

1. Inspect the rendered page to understand borders and merged cells.
2. Try `pdfplumber` extraction.
3. Validate row and column counts against the visual page.
4. Export structured data to CSV or JSON when requested.

Never present an extraction as complete when pages are encrypted, image-only, truncated, or visibly misparsed.

## Create or modify a PDF

Use page dimensions and margins intentionally. Keep typography, spacing, headers, footers, and page breaks consistent. When modifying an existing document, preserve metadata and untouched pages when practical.

After writing:

1. Open the generated PDF with `pypdf` and confirm it parses.
2. Render every changed page at a useful resolution.
3. Inspect for clipping, overlap, missing fonts, blank pages, and incorrect page order.
4. Run the bounding-box checker when the layout is dense.
5. Confirm the final file path and size.

## Fill forms

Run `scripts/check_fillable_fields.py` first. If fields exist, follow the AcroForm workflow in `forms.md`. If no fields exist, use the annotation workflow and verify placement against a rendered page.

Do not flatten a form unless the user requests a final non-editable copy. Never invent signatures or attestations.

## Safety and quality

- Treat PDFs as untrusted input; do not execute embedded content.
- Do not expose hidden metadata or extracted personal data unnecessarily.
- Keep passwords and credentials out of commands, logs, and generated scripts.
- Preserve accessibility tags when the chosen library supports them.
- Do not claim pixel-perfect fidelity without rendering and visual verification.
- Report pages that could not be processed and the reason.

## Deliverables

Return the output file, a concise summary of changes, and any validation caveats. For extraction tasks, state the page range and whether OCR was used. For edits, state whether the output remains editable or was flattened.
