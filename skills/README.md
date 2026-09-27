# Claude Code skills

Workflow skills that tell Claude Code how to drive Civil 3D 2027 and Revit 2027 through the MCP
servers this repo works with: `civil3d` (Civil3D-mcp), `revit-write` (revit-mcp-server), `revit`
(Autodesk's official read-only Revit MCP) and `civil3d-revit-bridge` (`../bridge`).

| skill | what it does |
|---|---|
| [civil3d-sheet-set-publish](civil3d-sheet-set-publish/SKILL.md) | layouts / page setups → PDF per layout or one combined PDF, with the approval flow |
| [civil3d-submittal-diff](civil3d-submittal-diff/SKILL.md) | snapshot at submittal, later diff by type, layer and Civil 3D object |
| [civil3d-drawing-qc](civil3d-drawing-qc/SKILL.md) | read-only pre-issue QC: units, CRS, xrefs, data shortcuts, standards, surfaces, pipes |
| [revit-model-audit-before-issue](revit-model-audit-before-issue/SKILL.md) | read-only Revit model-health report; fixes only on a copy |
| [civil3d-revit-site-handoff](civil3d-revit-site-handoff/SKILL.md) | bridge workflow: align → toposolid → utilities → consistency checks |

## Install

A skill is a folder containing `SKILL.md`. Claude Code picks up skills from
`%USERPROFILE%\.claude\skills\` (all projects) or `<project>\.claude\skills\` (one project).
Copy a folder there, or link it with a junction so edits in this repo take effect immediately:

```powershell
# one skill, user-wide, as a junction (no admin rights needed)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\civil3d-drawing-qc" `
         -Target "C:\dev\civil3d-automation\skills\civil3d-drawing-qc"

# or all of them
Get-ChildItem C:\dev\civil3d-automation\skills -Directory | ForEach-Object {
  New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\$($_.Name)" -Target $_.FullName
}
```

Restart Claude Code (or start a new session) and check with `/skills`. Claude loads a skill when
the request matches its description, or you can name it (`/civil3d-drawing-qc`).

The skills assume the MCP servers are registered under the names above. They encode behaviour
verified against live Civil 3D 2027 / Revit 2027 on 2026-09-26; see each file for the gotchas.
