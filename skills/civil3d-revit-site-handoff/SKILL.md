---
name: civil3d-revit-site-handoff
description: Hand a Civil 3D 2027 site design over to a Revit 2027 model with the civil3d-revit-bridge MCP server. Use when the user wants to georeference/align Revit shared coordinates to a Civil 3D drawing, bring a Civil 3D surface (existing or finished grade) into Revit as a toposolid, bring storm/sanitary/water pipes or site utilities into Revit, or check finished-floor elevation (FFE) vs grade, setbacks, or survey-point alignment between the two models. Runs bridge_status, bridge_align_coordinates, bridge_surface_to_toposolid, bridge_utilities_to_revit and bridge_check_consistency with the preview → apply gate, on a copy of the Revit model.
---

# Civil 3D → Revit site handoff

The bridge only reads Civil 3D and only writes Revit. Every write is two steps: call without
`apply` (preview, returns `previewId`), review, then the **same arguments** plus `apply:true,
previewId`. A previewId is single-use, expires after 15 minutes, only works in the same bridge
server session, and is refused if the arguments or live data changed. Lengths in bridge
arguments are **drawing units** unless the name ends in `_mm`.

## Preconditions (check all before step 1)

1. **Revit model copy.** The bridge writes into whatever Revit document is active, with no undo
   across the session. Ask the user to File > Save As a copy (e.g. `<name>-site-import.rvt`) and
   work in that. Confirm the active document name (bridge_status / `revit.get_running_revit_instances`).
   Don't continue on the original.
2. Revit: **Revit MCP Switch** clicked; no dialog open (dialogs block every command).
3. Civil 3D: the right drawing is active (the MCP cannot open drawings; the user opens it, or use
   the COM harness from `powershell.exe`), UI live (no modal dialog, not locked or minimized).
4. Know the drawing's foot: US survey vs international. The bridge prints units warnings; honor
   them or pass `drawingUnits:"usSurveyFeet"` explicitly.

## Steps

1. **`bridge_status {}`.** Both plugins reachable; Civil 3D drawing, units, CRS; Revit project,
   levels, current project location; probed commands (`getSurfaceTinVertices`,
   `getParcelGeometry`, `getDrawingUnits`, `create_toposolid`, `create_pipe`,
   `set_shared_coordinates`, ...). Stop if either side is unreachable or a command you need is
   missing. Read every warning to the user.
2. **Align coordinates (always first).** `bridge_align_coordinates` with
   `civil3dPoint` (`{pointNumber}` / `{pointName}` / `{northing, easting, elevation}`),
   `revitInternalPoint_mm` (default origin), and `rotation`: prefer
   `{source:"twoPoints", civil3dPoint, revitInternalPoint_mm}` when two matching control points
   exist (its length check catches unit errors); else `{source:"civil3dNorth"}` or
   `{source:"explicit", angleToTrueNorth_deg}`.
   - Preview: review the `set_shared_coordinates` payload, `before`, the move distance and the
     round-trip check. Revit's dry-run result is included; stop if it was rejected.
   - Apply with `apply:true, previewId`. Then `verification.pass` **must be `true`**. `false` →
     report the errors (possibly the rotation sign convention) and stop. `null` → the read-back
     failed; run `bridge_check_consistency {alignment:{civil3dPoint, revitReference:"surveyPoint"}}`
     and only continue when that passes.
3. **Surface → toposolid.** `bridge_surface_to_toposolid {surfaceName, ...}`.
   - `sampling`: `"grid"` (default; regular spacing, works everywhere) or `"tin"` (the
     surface's own vertices; keeps breaklines and ridges better; needs `getSurfaceTinVertices`).
   - `boundary`: always give one for large surfaces, e.g. building footprint + margin,
     `{coordinateSystem:"civil3d", points:[{x,y},...]}`. Default is the whole bounding box.
   - `maxPoints` (4–20000, default 2000). Raise gradually; big toposolids are slow in Revit.
     `gridSpacing` is coarsened automatically to fit.
   - Optional `toposolidTypeName`, `levelName`, `name`.
   - Preview: check point count, spacing, elevation range (sane for the site?), decimation notes,
     any `blocking` reasons (e.g. placement > ~32 km from the internal origin means alignment was
     skipped). Then apply; check the result's Revit `warnings` array and confirm with
     `revit-write.get_toposolids`.
4. **Utilities.** First `bridge_utilities_to_revit {mode:"report", include:"both",
   footprint, distance}` (or `networks`/`boundary`). Review pipe count, diameters (Civil 3D
   reports inner diameter in drawing units; a warning about diameters > 8 means pass
   `diameterUnits:"inches"`), inverts, skipped pipes, and each pipe's connection point.
   Then, only if the user wants pipes modeled: get system/pipe type names
   (`revit-write.get_mep_systems`), and call `mode:"create"` with `levelName`,
   `systemMapping:[{network:"/Storm/", systemTypeName:"Storm Drain"}...]` or
   `defaultSystemTypeName`/`defaultPipeTypeName`, `maxPipes`. Preview → apply. Pipes are placed at
   **centreline** elevations. Verify with `revit-write.get_mep_elements`.
5. **Consistency.** `bridge_check_consistency` with `footprint` plus any of:
   - `ffe:{surfaceName, levelName, minAboveGrade, maxAboveGrade?}`: compares the Revit level
     elevation (in shared coords) with the **max** grade under/along the footprint (and min for
     `maxAboveGrade`). Use pads for multiple floor plates.
   - `setbacks:{parcel:{siteName, parcelName}, default, perEdge?}`. Parcels with holes (road ROW)
     return only the outer loop; mention it if relevant.
   - `alignment:{civil3dPoint, revitReference:"surveyPoint", horizontalTolerance?}`.
   Report `overall` and each check's `status`, `summary` and key `details`.

## Stop conditions

- Not on a Revit copy → stop.
- Alignment not applied, or `verification.pass` not true → don't run toposolid or create pipes.
- Preview shows `blocking` reasons, Revit rejected the dry run, or apply says arguments/data changed
  → fix the cause and preview again; never reuse an old previewId.
- Unit warning unresolved (US survey vs international foot) → ask the user.

## Report

Units and CRS used; transform applied (`before` → `after`, verification); toposolid (surface,
sampling, points, element ID); pipes created or reported; consistency results; every warning.
