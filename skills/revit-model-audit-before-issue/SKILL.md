---
name: revit-model-audit-before-issue
description: Audit a live Revit 2027 model before issue/submittal/model delivery, read-only, using the official Autodesk `revit` MCP server plus the read tools of the `revit-write` server, and produce a model-health report. Use when the user asks to audit, health-check or QC a Revit model, find Revit warnings, unplaced views, untagged or undimensioned elements, purgeable families/types, CAD imports, unloaded links, in-place families, or wants a pre-issue checklist for a Revit project. Any cleanup happens only on a model copy and only with the user's explicit OK.
---

# Revit model audit before issue

The `revit-write` server has **no approval gate**: a write tool changes the model the moment it is
called. This skill is read-only on the live model. Every call below is a read or a `dryRun`.

## Before you start

- The `revit-write` listener only runs after the user clicks **Revit MCP Switch** on the ribbon.
  If its tools fail to connect, ask the user to click it.
- Revit blocks every MCP command while a dialog is open. If calls hang or time out, ask the user to
  close dialogs and return Revit to an idle state.
- To test the connection use `get_project_info {compact:true}`: it needs Revit's API context, so
  it also tells you whether Revit is free. `say_hello` only proves the socket is up.
- Official `revit` server: first `get_running_revit_instances`; use the returned process ID as
  `revitInstanceId` on every call, and confirm the document name with the user. Its lengths are in
  **feet**; `revit-write` uses **millimetres**.
- Known bug: `get_element_data` with `parametersOutputType:"SpecificParameters"` always errors.
  Use `KeyParameters` or `AllParameters`.

## Steps (all read-only)

1. **Identify the model.** `revit.get_running_revit_instances` → PID + document.
   `revit-write.get_project_info {compact:false}` → name, number, levels, phases, worksets, links.
2. **Scored overview.** `revit-write.check_model_health` (score 0–100, grade, warning types,
   in-place families, CAD imports, unplaced rooms, unused views, detail lines, recommendations).
   For a second opinion `workflow_model_audit {includeWarnings:true, includeFamilies:true,
   maxWarnings:50}` (can take minutes on large models).
3. **Warnings.** `get_warnings {severityFilter:"All", maxWarnings:500}`. Group by description text
   and count; call out duplicates/overlaps, room separation, "not enclosed", identical instances in
   the same place. `severityFilter:"Error"` separately.
4. **Model size.** `analyze_model_statistics {compact:true}`; totals by category and level.
5. **Views and sheets.** `manage_unplaced_views {action:"list"}` (list only; leave dryRun at its
   default true). Exclude obvious working views (`excludeNames:["Working","{3D}","Copy of"]`) if
   the user agrees. `revit.query_model` with `categories:["OST_Sheets"]`, `maxResults` sized to the
   project, for the sheet count; `revit.get_element_data` with `KeyParameters` for sheet
   numbers/names if needed.
6. **Tags and dimensions** (view-based; ask which plans/sheets matter). For each key view ID:
   `find_untagged_elements {viewId, categories:["OST_Doors","OST_Windows","OST_Rooms","OST_Walls"]}`
   and, for structural/GA plans, `find_undimensioned_elements {viewId}`.
   `wipe_empty_tags {}` (dryRun defaults to true: it only lists empty/orphan tags).
7. **Families and purgeable content.** `audit_families {includeUnused:true}`; then
   `purge_unused {dryRun:true}` for the purgeable count. Never pass `dryRun:false` here.
8. **Links and CAD.** `manage_links {action:"list"}` (flag unloaded/not found);
   `cad_link_cleanup {action:"list"}` (flag imported, not linked, CAD).
9. **Georeference (site-related projects).** `get_project_location` → survey point, project base
   point, angle to true north, shared transform. Flag an untouched survey point (all zeros) on a
   project that should be on shared coordinates.

## Report

- Header: model, Revit PID, date, health score/grade.
- Table of checks → count → status (OK / Review / Fix before issue) → evidence.
- Top warning types with counts and example element IDs (use `revit.select_elements` /
  `zoom_to_elements` only if the user wants to look at them).
- Unplaced views, untagged/undimensioned by view, purgeable items, CAD imports, link status.
- A prioritized cleanup list, each item naming the tool call that would do it.

## If the user wants fixes

1. Get an explicit "yes, fix X" for each item.
2. Work on a **copy**: ask the user to File > Save As a new name (for a workshared model: open
   detached / save as new central). Confirm with `get_running_revit_instances` and
   `get_project_info` that the copy is the active document before any write.
3. Run the tool with `dryRun:true` first (`purge_unused`, `wipe_empty_tags`,
   `manage_unplaced_views {action:"delete"}`, `delete_element` all support it), show the list,
   then rerun with `dryRun:false` only for what the user approved.
4. Check each result's `warnings` array (Revit warnings come back there instead of as a dialog)
   and re-run the relevant audit step to confirm.

## Stop conditions

- Can't confirm which document is active, or it's the live issue model and a write is requested
  → stop; ask for a copy.
- A read call times out twice → a dialog is probably open; ask the user, don't loop.
- Never use `send_code_to_revit`, `delete_selection`, or `cad_link_cleanup {action:"delete"}` in
  an audit.
