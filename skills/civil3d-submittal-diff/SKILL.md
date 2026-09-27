---
name: civil3d-submittal-diff
description: Track and summarize what changed in a Civil 3D 2027 drawing between submittals using the civil3d MCP server's civil3d_compare tool. Use when the user wants to baseline/fingerprint/snapshot a drawing at submittal or issue, asks "what changed since the last submittal / 60% set / last review", wants a revision narrative or change log, or wants to diff the active drawing against another DWG (an older issued copy). Covers snapshot (approval-gated JSON export), compare_snapshot, compare drawing, and summarizing changes by entity type, layer and Civil 3D object (alignments, profiles, surfaces, pipe networks).
---

# Civil 3D submittal diff

Tools: `civil3d_compare` (`snapshot`, `compare_snapshot`, `drawing`), `civil3d_request_approval`,
`civil3d_drawing`, `civil3d_health`. Nothing here modifies the drawing. `snapshot` writes a JSON
file and is approval-gated; the two compare actions are read-only.

## Before you start

- Civil 3D must be in the foreground-capable state: no modal dialog, screen not locked, window not
  minimized. Stalled calls almost always mean one of these.
- The MCP cannot open drawings. If the needed DWG is not active, ask the user to open it (or use
  the COM harness from `powershell.exe`: `Import-Module C:\dev\civil3d-automation\harness\C3D.psm1;
  $app = Get-C3DApp; $app.Documents.Open('<path>', $false)`).
- Snapshot and comparison paths must be absolute and inside the plugin's file roots
  (`CIVIL3D_FILE_ROOTS`, default the user's Documents). Snapshot paths end in `.json`, compare
  targets in `.dwg`.
- Suggested snapshot location: `<Documents>\Submittals\<project>\<drawing>-<milestone>-<yyyy-mm-dd>.json`.

## A. Take a baseline at submittal

1. `civil3d_drawing {action:"info"}`: confirm the drawing and check `unsavedChanges`. A baseline
   should match the issued file, so if there are unsaved changes, tell the user and ask whether to
   save first (saving needs its own approval) or snapshot as-is.
2. Parameters: `{action:"snapshot", outputPath:"<...>.json", includeCivilSummaries:true}`
   (`overwrite` defaults to false; keep it that way so an old baseline is not clobbered).
3. `civil3d_request_approval {toolName:"civil3d_compare", action:"snapshot", parameters}` → then
   `civil3d_compare` with the identical parameters plus `approvalToken`.
4. Record `outputPath`, `entityCount`, `civilObjectCount`, `contentHash`, `capturedAtUtc`, and
   any `warnings`. Tell the user where the baseline lives. Don't edit the JSON.

## B. What changed since the baseline

1. Open/confirm the current drawing (same file lineage as the snapshot).
2. `civil3d_compare {action:"compare_snapshot", snapshotPath:"<...>.json", maxDetails:200}`
   (`maxDetails` 0–5000; raise it only if the user wants the full list).
3. If the user instead has an older **DWG** (e.g. the issued copy), use
   `civil3d_compare {action:"drawing", otherPath:"<old>.dwg"}`. The other DWG is read as a side
   database, never opened. Here "baseline" is the other file and "current" the active drawing;
   say so in the report.

## Reading the result

- `summary`: `added`, `removed`, `modified`, `unchanged`, `layerChanges`, `identical`. If
  `identical` is true, say so and stop.
- `baseline` / `current`: source path, `capturedAtUtc`, counts and `warnings`. Check the snapshot
  source path matches the current drawing; a different file means the comparison is misleading.
- `byType` and `byLayer`: rows `{name, added, removed, modified}`. Sort by total change and show
  the top ~10 of each.
- `civil.byKind`: per Civil 3D object kind, baseline vs current counts and add/remove/modify.
  `civil.modified[]` has `{kind, name, changes}`; `changes` holds e.g. alignment length or
  geometry hash, profile PVIs, surface statistics, pipe counts/inverts. These are the engineering
  changes reviewers care about, so list every one by name with its changed fields.
- `details.added/removed/modified`: entity rows (handle, type, layer, space, previousLayer).
  If `details.truncated` is true, say the list is partial.
- `notes`: always relay.

## Report format

1. One-line verdict (e.g. "42 entities changed on 6 layers; 2 civil objects modified").
2. Civil 3D object changes: table of kind, name, what changed (from → to where given).
3. Changes by layer and by type (top rows).
4. Notable adds/removes (paper space vs model space matters: title block edits vs design edits).
5. Caveats: truncation, warnings, unsaved state at snapshot time.

Offer to write the summary as a revision narrative; don't invent reasons for changes.

## Stop conditions

- Snapshot/compare path outside the file roots → tell the user the allowed roots; don't retry
  with guesses.
- Snapshot target exists → ask for a new name rather than `overwrite:true`.
- Source path in the snapshot differs from the active drawing → confirm with the user before
  reporting a diff.
