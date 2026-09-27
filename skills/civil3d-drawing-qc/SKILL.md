---
name: civil3d-drawing-qc
description: Run a read-only pre-issue quality check on the active Civil 3D 2027 drawing through the civil3d MCP server and produce a QC report. Use when the user asks to QC, audit, check or review a drawing before issue/submittal/plotting, asks whether a drawing is "ready", or wants to find broken or unloaded xrefs, out-of-date or broken data shortcuts, wrong units or coordinate system, layer/standards violations, missing labels, surface spikes, or pipe cover/slope problems. Reports only; never fixes anything without explicit user approval.
---

# Civil 3D pre-issue drawing QC

Everything below is read-only. Do **not** call any fix/repair/sync/reload/save action as part of
QC. Collect findings, then offer fixes separately; each fix needs the user's OK and then
`civil3d_request_approval` with the exact parameters.

## Before you start

- Civil 3D must have a live UI: no modal dialog, not locked, not minimized. If calls hang, ask the
  user to bring Civil 3D forward.
- QC runs on the **active** drawing. The MCP cannot open drawings; ask the user to open it, or use
  the COM harness from `powershell.exe` (`Import-Module C:\dev\civil3d-automation\harness\C3D.psm1;
  $app = Get-C3DApp; $app.Documents.Open('<path>', $false)`).
- Ask for the project's expectations if not known: linear unit (US survey ft vs intl ft vs m),
  coordinate zone, layer prefix, min pipe cover/slope. Otherwise report values without judging.

## Steps

1. **Environment.** `civil3d_health`, then `civil3d_drawing {action:"info"}` (path, object counts,
   `unsavedChanges`).
2. **Units.** `civil3d_drawing {action:"units"}`. Report `lengthUnit`, `insunitsName`,
   `lengthUnitSource`, `unitsConsistent` and every `warnings` entry. Flag: INSUNITS disagreeing
   with Civil 3D drawing settings, and US survey foot vs international foot mismatches (3.66 m at
   a 6,000,000 ft easting).
3. **Coordinate system.** `civil3d_coordinate_system {action:"info"}`. Flag no CRS assigned, or a
   zone that differs from the project's. Optionally spot-check a known point with
   `{action:"transform", fromSystem:"drawing", toSystem:"geographic", x, y}`.
4. **Xrefs.** `civil3d_xref {action:"list", includeNested:true}`. From `statusCounts` and `xrefs[]`
   flag `unloaded`, `not_found`, `unresolved`, `orphaned`, `unreferenced`; absolute paths
   (`pathType:"absolute"`) that will break when the set is transmitted; `savedPath` ≠ `foundPath`;
   `hostIsSaved:false`.
5. **Data shortcuts.** `civil3d_project {action:"data_shortcut_references"}` (use
   `onlyProblems:true` on big drawings). Flag status `out_of_date`, `broken`, `source_missing`,
   `isPartial`, and `sourceLocation` other than `current_project`. Relay `notes`, and report
   `workingFolder` / `currentProjectPath`.
6. **Drawing standards.** `civil3d_standards {action:"check_drawing_standards", layerPrefix?,
   checkLineweights:true, checkColors:true}` and `civil3d_standards {action:"check_labels",
   objectType:"all", checkMissing:true, checkStyleViolations:true}`. Optionally
   `civil3d_workflow {action:"drawing_readiness_audit", layerPrefix?, limit:200}` for a combined
   summary (read-only).
7. **Surfaces.** `civil3d_surface {action:"list"}`; for each design/existing surface
   `civil3d_qc {action:"check_surface", name, spikeThreshold?, flatTriangleThreshold?}` and
   `civil3d_surface {action:"get_statistics", name}`. Flag spikes, flat triangles, implausible
   min/max elevations, zero-area or out-of-date surfaces.
8. **Pipe networks.** `civil3d_pipe {action:"list"}`; per network `civil3d_qc
   {action:"check_pipe_network", name, minCover?, minSlope?, maxSlope?}`. If a surface is
   referenced, `civil3d_pipe {action:"check_interference", networkName, targetType:"surface",
   targetName}`. Use `civil3d_pipe {action:"get", name}` to quote inverts and endpoints for any
   flagged pipe.
9. **Alignments/profiles/corridors (if present).** `civil3d_qc` `check_alignment {name,
   designSpeed?}`, `check_profile {alignmentName, profileName}`, `check_corridor {name}`.
10. **Parcels (if present).** `civil3d_parcel {action:"get_geometry", siteName, parcelName}` only
    when areas matter. Parcels with holes (e.g. road ROW) return only the outer loop; read
    `notes` for the area-mismatch warning and don't report that as a drafting error.

`civil3d_qc {action:"generate_report", outputPath}` writes a file; check it with
`civil3d_preview_action` first and only run it if the user wants a file.

## Report

Group findings as **Blocker** (broken/missing xrefs or shortcuts, unit/CRS mismatch, surface
spikes in a design surface, pipe cover violations), **Warning** (out-of-date shortcuts, unloaded
xrefs, absolute paths, standards/label violations), **Info** (counts, units, CRS). Each finding
gets: what, where (object name/handle/layer), evidence (the value returned), and a suggested fix
with the tool/action that would do it. End with a pass / pass-with-warnings / fail verdict.

## Offering fixes (only after explicit OK, one at a time)

- Out-of-date shortcuts: `civil3d_project {action:"data_shortcut_sync", dryRun:true}` first, then
  the real sync with approval.
- Broken shortcut: `data_shortcut_repair {objectType, objectName, sourcePath}` (objectName as
  listed; for profiles the profile's own name).
- Unloaded/moved xrefs: `civil3d_xref` `reload` / `repath {name, newPath, pathType:"relative", reload:true}`.
- Layer standards: `civil3d_standards {action:"fix_drawing_standards", dryRun:true}` first.
All of these are approval-gated: `civil3d_request_approval` with the identical parameters, then
call with `approvalToken`.

## Stop conditions

- No active drawing or wrong drawing → stop and ask.
- A check errors (missing object, plugin timeout) → note it in the report as "not checked" and
  continue with the others; don't retry more than once.
