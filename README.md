# civil3d-automation

Scripting a **running Autodesk Civil 3D** session from outside it — a .NET add-in, a
PowerShell COM harness, and the AutoLISP that turned out to be safer than the .NET API for
sheets and plotting.

Built and verified against **Civil 3D 2027** (AutoCAD 2027, `26.0s`) on Windows 11.

The most useful file here is probably **[docs/FINDINGS.md](docs/FINDINGS.md)** — the things
that are not in the documentation, including the four APIs that crash the host rather than
throwing.

---

## Why this exists

Civil 3D has three automation surfaces and none of them covers everything:

| Channel | Reaches | Doesn't reach |
|---|---|---|
| MCP plug-in (TCP) | drawings, COGO points, point groups, surfaces | styles, description keys, layers, blocks, plotting |
| AutoCAD COM | any command, the AutoCAD object model | **point styles and label styles are `null`** |
| .NET add-in (`NETLOAD`) | the whole Civil 3D API | some of it crashes the process |

So a real workflow needs all three, plus a way to get results back out (`SendCommand` is
fire-and-forget). That's what this repo is.

## Three things that will cost you an afternoon

**1. COM needs Windows PowerShell, not PowerShell 7.** `Marshal.GetActiveObject` was
removed in .NET Core, so `pwsh` cannot attach to a running AutoCAD at all. Use
`powershell.exe`.

**2. Your own delimiters will collide with Civil 3D's field syntax.** Label field codes
contain pipes:

```
<[Point Elevation(Uft|P2|RN|AP|Sn|OF)]>
```

Split that on `|` and the label silently renders as literal text at every point.

**3. Label text height is in DRAWING units.** In a feet drawing the stock `0.008333` is
0.1 inch. Setting "0.06" gives you 0.72-inch lettering.

## Layout

```
src/Civil3dAutomation/   NETLOAD add-in (net10.0-windows)
  Config.cs              key=value settings from a file next to the DLL
  Inspect.cs             C3DINFO / C3DAPI - read-only reconnaissance
  SurveySetup.cs         layers, bulk block import, point + label styles, description keys
harness/C3D.psm1         attach over COM, NETLOAD, run commands, detect deadlock
lisp/sheet.lsp           layout + viewport + border + north arrow + scale bar
lisp/plot.lsp            the verified -PLOT prompt chain, and how to rediscover it
docs/FINDINGS.md         everything learned the hard way
```

## Getting started

```powershell
# 1. build (AcadDir defaults to AutoCAD 2027)
dotnet build src/Civil3dAutomation -c Release
#    other install:  dotnet build src/Civil3dAutomation -c Release -p:AcadDir="C:\Program Files\Autodesk\AutoCAD 2026"

# 2. tell the add-in where to write logs / find blocks
cp src/Civil3dAutomation/c3d.paths.txt.example `
   src/Civil3dAutomation/bin/Release/net10.0-windows/c3d.paths.txt

# 3. drive it  (powershell.exe, NOT pwsh)
Import-Module ./harness/C3D.psm1
$app = Get-C3DApp
$doc = Ensure-C3DDocument -App $app        # MCP plug-ins deadlock at zero documents
Invoke-C3DNetload -Dll (Resolve-Path ./src/Civil3dAutomation/bin/Release/net10.0-windows/Civil3dAutomation.dll)
Invoke-C3DCommand -Command C3DINFO -LogFile C:\Temp\c3d\c3dinfo.out -DoneMarker done
```

`Add-C3DTrustedPath` whitelists just your build folder for `NETLOAD`. **Don't** set
`SECURELOAD=0` — that turns off code-path verification globally.

## Reconnaissance beats guessing

The API surface is large and sparsely documented, so both included habits are worth
copying.

**Read the drawing.** `C3DINFO` dumps point styles, label styles (including each
component's exact field code and height), layer and block counts — so you can copy the
field syntax the template already uses instead of guessing `Uft` vs `Um`.

**Read the metadata offline.** You don't need Civil 3D running to reflect over its
assemblies — `MetadataLoadContext` will do it, and that is how the non-obvious signatures
in `FINDINGS.md` were found, e.g.:

```csharp
PointDescriptionKeySetCollection.GetPointDescriptionKeySets(db)  // static, takes a Database
CogoPointCollection.ImportPoints(file, fmt, false, false, false) // static
ps.MarkerSymbolName = "srv062";                                  // flat property, not a sub-object
```

## Things that crash the host

Documented fully in [docs/FINDINGS.md](docs/FINDINGS.md). In short:

- Creating/configuring a paper-space `Viewport` through .NET **while that layout is
  current** — use the `MVIEW` command instead.
- Erasing paper-space **viewport #1** — corrupts the layout so the DWG then crashes *on
  open*. `ERASE ALL` from the command line can't select it; iterating the
  `BlockTableRecord` in .NET can.
- `PlotFactory` / `PlotEngine` from a `SendCommand` context — use `-PLOT`.
- `PlotSettingsValidator.SetPlotCentered` when the plot type is `Layout` — `eInvalidInput`.

That is why `lisp/` exists: sheets and plotting are done with commands, on purpose.

## Is it busy or is it wedged?

`Process.Responding` returns `True` for both. Sample CPU instead:

```powershell
Test-C3DBusy    # < ~0.15 CPU-seconds per 6s wall clock => idle, not working
```

If AutoCAD is stuck at a command prompt it rejects COM with `RPC_E_CALL_REJECTED`, and no
COM call can clear it — only real keystrokes: `Reset-C3DCommandLine`.

## Scope

`SurveySetup.cs` carries a **two-row illustrative** feature-code table. It's a worked
example of the mechanism (layer + marker + label + description keys per code), not a
survey coding standard — replace it with your own.

## Licence

MIT — see [LICENSE](LICENSE).
