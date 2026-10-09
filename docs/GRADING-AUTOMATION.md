# Automating Civil 3D grading (2027)

Civil 3D 2027 has **no .NET or COM API** for grading groups, gradings, infills or the
Grading Volume Tools. `Autodesk.Civil.DatabaseServices.Grading` has no members,
`GradingGroup` does not exist, the AeccXLand COM library only exposes grading *settings*,
and the civil3d MCP server's grading tools look for these members by reflection and find
nothing. What *is* in the API: `FeatureLine` (create, `SetPointElevation`), `Site`,
`GradingCriteriaSet` / `GradingCriteria`, and the command settings
(`SettingsCmdGradingTools.GradingLayoutTools.GradingCriteriaSetId/CriteriaId`).

The rest goes through the real commands. Verified end to end on 2026-10-08 (CEIE 472 HW #6:
pad graded to EG at 3:1 cut / 4:1 fill, then auto-balanced), with the Windows session
locked. `harness/C3DInput.ps1` has the helpers used below.

## Recipe

1. **API**: create the site and feature line, set its elevations, create the criteria
   set/criteria, and make them current through `SettingsCmdGradingTools`.
2. **`_AeccCreateGradingGroup`**, sent with `SendCommand` from a *separate process* (the call
   blocks while the modal dialog is up). Dialog **Create Grading Group**: name edit `17144`;
   the real check boxes are the captioned buttons `901760736` (Automatic surface creation)
   and `901762344` (Volume base surface); OK = `1`. Next comes **Create Surface**, where OK = `1`.
3. **`_AeccGradingTools`** opens the modeless **Grading Creation Tools** toolbar. Set the group
   (button `17039` -> **Select Grading Group**, OK `1`) and the target surface (button `17041`
   -> **Select surface**, OK `1`). Without these, a typed `_AeccCreateGrading` silently
   exits right after "Select the feature:".
4. Toolbar button `17030` = Create Grading. Answer the prompts with `Send-C3DInput`:
   a typed point *on* the feature line, a point on the grading side, Enter for
   "Apply to entire length?", then Enter for each slope (the criteria defaults), then ESC.
5. **`_AeccCreateGradingInfill`**, then a point inside the pad, then Enter.
6. **`_AeccGradingVolumeTools`**: button `17042` opens **Auto-Balance Volumes** (required volume
   edit `17142`, OK `1`). Cut/fill/net can be read through UI Automation as the `Name` of the
   edits `17150` / `17151` / `17152`. They match a `TinVolumeSurface` between EG and the group surface.

## Gotchas

- **Slopes are stored rise/run.** `GradingCriteria.CutSlope.Value = 3.0` with
  `CutSlopeFormatType = Slope` gives a **0.33:1** slope (the prompt shows `<0.33:1>`). Use
  `1.0/3.0` for 3:1. The stock .NET subassemblies work the same way (`CutGrade` 0.3333 = 3:1).
- While a command waits for input, **COM is rejected** (`RPC_E_CALL_REJECTED`). Post
  `WM_CHAR` to `GetGUIThreadInfo(...).hwndFocus` of acad's GUI thread. ESC there cancels.
- Read prompts from the command log: `LOGFILEMODE=1`, file `LOGFILENAME`. The log is one
  prompt behind, so the line for a prompt appears only after it has been answered.
- A feature line created through the API owns a hidden `AeccDbGrading` on layer 0 that later
  becomes the infill. Don't erase it.
- Erasing a grading through the API also removes its daylight feature line.
- When freezing every layer in a viewport (`VPLAYER F *`), surface **style components draw on
  their own layers** (e.g. triangles on `C-TINN-VIEW`), so the surface vanishes. Set the
  component layer to `0` (= the object's layer) for surfaces you want to keep.
