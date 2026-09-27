---
name: civil3d-sheet-set-publish
description: Plot or publish Civil 3D 2027 paper-space layouts to PDF through the civil3d MCP server (civil3d_plot). Use when the user asks to plot sheets, print layouts to PDF, publish a sheet set, make a combined/multi-page PDF, export drawings for submittal or issue, or asks which layouts, page setups, plotters or paper sizes a drawing has. Covers list_layouts, list_page_setups, list_plotters, plot_layouts_to_pdf, publish_sheet_set, the approval-token flow, the DWG To PDF paper-size gotcha, background jobs, and verifying the PDFs on disk.
---

# Civil 3D sheet set to PDF

Tools: `civil3d_plot`, `civil3d_preview_action`, `civil3d_request_approval`, `civil3d_job`,
`civil3d_drawing`, `civil3d_health`. Discovery actions are read-only and never gated; both output
actions need an approval token.

## Before you start

- Civil 3D only answers plugin requests while its UI is live. If calls hang: the screen may be
  locked, the window minimized/unfocused, or a **modal dialog is open** (that blocks everything).
  Ask the user to bring Civil 3D forward and dismiss dialogs; don't keep retrying.
- The MCP cannot open a drawing. If the right DWG is not active, ask the user to open it, or open it
  with the COM harness from **Windows PowerShell** (`powershell.exe`, not `pwsh`):
  `Import-Module C:\dev\civil3d-automation\harness\C3D.psm1; $app = Get-C3DApp; $app.Documents.Open('<path>', $false)`
- Output paths must be absolute and inside `CIVIL3D_EXPORT_ROOTS` / `CIVIL3D_FILE_ROOTS`
  (default: the user's Documents). Pick e.g. `%USERPROFILE%\Documents\Plots\<project>\`.
  The folder may need to exist already; create it with PowerShell if needed.

## Steps

1. `civil3d_health` then `civil3d_drawing` `{action:"info"}`. Confirm the drawing name/path is the
   one the user means and note `unsavedChanges`.
2. `civil3d_plot` `{action:"list_layouts"}`. Record for each layout: `name`, `tabOrder`,
   `pageSetup`, `device`, `canonicalMediaName`, `paperWidth/Height`, `orientation`,
   `plotStyleTable`. Show the user the list and confirm which layouts to output (default: all
   paper-space layouts in tab order).
3. If layouts share a named page setup, `{action:"list_page_setups"}` and prefer
   `pageSetup:"<name>"` over hand-picking settings.
4. Paper size. `plot_layouts_to_pdf` plots on **DWG To PDF.pc3** and validates the paper size up
   front, so a layout set up for another device (or a local printer's "Letter") fails. Get valid
   names with `{action:"list_plotters", device:"DWG To PDF.pc3"}` and pass the exact name, e.g.
   letter-size landscape → `paperSize:"ANSI A (11.00 x 8.50 Inches)"`; 22x34 → the matching
   `ANSI D` entry. Pass `plotStyleTable` (e.g. `"monochrome.ctb"`) only if the user wants it.
5. Choose the output action:
   - One PDF per layout: `plot_layouts_to_pdf` with `layoutNames:[...]` **or** `allLayouts:true`
     (not both) and **exactly one** of `outputDirectory` (several layouts) or `outputPath`
     (one layout, `.pdf`). Optional `fileNamePrefix` (default `<drawing>-`), `overwrite` (default
     false), `continueOnError` (default true).
   - One combined multi-sheet PDF: `publish_sheet_set` with `outputPath` (`.pdf`) and either
     `layoutNames` or `sheets:[{layoutName, drawingPath?}]` (not both; omit both = every layout).
     `drawingPath` lets sheets come from other DWGs inside the import roots.
   - More than ~5 sheets: add `asJob:true`.
6. Approval (single use, bound to the exact parameters **and** the drawing state):
   - Build the full parameter object including `action`, e.g.
     `{action:"plot_layouts_to_pdf", allLayouts:true, outputDirectory:"C:\\Users\\...\\Plots", paperSize:"ANSI A (11.00 x 8.50 Inches)"}`.
   - Optional `civil3d_preview_action {toolName:"civil3d_plot", action, parameters}` to validate.
   - `civil3d_request_approval {toolName:"civil3d_plot", action, parameters}` → `approvalToken`.
   - Call `civil3d_plot` with the **identical** parameters plus `approvalToken`. Any change (even
     adding `overwrite`) needs a new token. Token TTL is 5 minutes.
7. If `asJob:true`, poll `civil3d_job {action:"status", jobId}` until `state` is `completed` or
   `failed` (poll every ~10 s; don't hammer it).
8. Check the result:
   - plot: `requested`, `plotted`, `failed`, `skipped`, and per layout `status`, `outputPath`,
     `bytes`, `pageCount`, `error`; read `warnings`.
   - publish: `outputPath`, `bytes`, `pageCount` vs `sheetCount`, `sheets`, `warnings`.
9. Verify on disk with PowerShell: each file exists, size > 0 and matches `bytes`, and the
   timestamp is from this run (not a stale file when `overwrite` was false).

## Plot-then-publish gotcha

Plotting marks the drawing modified. `publish_sheet_set` defaults to `requireSaved:true`, so a
publish right after a plot is refused. Either ask the user and save (`civil3d_drawing
{action:"save"}` also needs approval), or pass `requireSaved:false` (the publish then uses the
in-memory state). Because the approval token is bound to the drawing fingerprint (which includes
unsaved state), request the publish approval **after** the plot finishes.

## Stop conditions

- Wrong drawing active, or the user hasn't confirmed which layouts → stop and ask.
- Paper size rejected and no DWG To PDF size clearly matches → show the list and ask.
- `failed > 0` or `pageCount` ≠ expected → report the per-layout errors; don't re-plot blindly.
- Target file exists and `overwrite` wasn't agreed → ask before re-requesting approval with
  `overwrite:true`.
- Never save, overwrite, or change page setups without the user's explicit OK.

## Report

Table of layout → PDF path → pages → bytes → status, plus any warnings and whether the drawing
now has unsaved changes caused by plotting.
