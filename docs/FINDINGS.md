# What can actually drive Civil 3D, and what can't

Notes from wiring an agent up to a live **Civil 3D 2027** (`26.0s`, AutoCAD 2027) session
on Windows 11. Everything here was verified against a running instance, not taken from docs.

## Three channels

| Channel | Reach | Notes |
|---|---|---|
| MCP plugin (TCP, port 8757) | Drawings, COGO points, point groups, surfaces, corridors, plan production | Styles are read-only (list/get); no style or label-style authoring, no description keys, no layers, no blocks, no plotting |
| AutoCAD COM (`AutoCAD.Application`) | Anything expressible as a command, plus the AutoCAD object model | **Windows PowerShell 5.1 only** |
| Civil 3D .NET (`AeccDbMgd`, via `NETLOAD`) | The whole Civil 3D API | Some of it will crash the host — see below |

### COM needs Windows PowerShell, not PowerShell 7

`[Runtime.InteropServices.Marshal]::GetActiveObject` was removed in .NET Core, so
PowerShell 7 cannot attach to a running AutoCAD at all:

```
Method invocation failed because [System.Runtime.InteropServices.Marshal]
does not contain a method named 'GetActiveObject'.
```

Run the harness under `powershell.exe` (5.1). `pwsh` will not work.

The Civil 3D COM object model is a separate ProgID, obtained *through* the AutoCAD app
object, and it is version-stamped:

```powershell
$acad = [Runtime.InteropServices.Marshal]::GetActiveObject('AutoCAD.Application')
$aecc = $acad.GetInterfaceObject('AeccXUiLand.AeccApplication.13.9')   # 13.9 = C3D 2027
```

Find the suffix for your release under `HKLM:\SOFTWARE\Classes\AeccXUiLand.AeccApplication*`.

### The MCP plugin deadlocks with zero documents open

Every action is validated by an internal `getDrawingInfo` call. With no drawing open that
call never returns, and because the plugin has a single-threaded queue, **the whole server
wedges** — including the request that would have opened the first drawing. Observed stuck
at 233s and never recovering.

Bootstrap a document through COM *before* touching the MCP server:

```powershell
$acad.Documents.Add($templatePath)
```

## What COM cannot reach

`AeccDocument.Styles.PointStyles` and `.PointLabelStyles` come back **null**. Description
key sets and point groups are fully available; styles are not:

| COM member | Works |
|---|---|
| `PointDescriptionKeySets.Add(name)` | yes |
| `PointGroups.Add(name)` | yes |
| `Styles.PointStyles` | **null** |
| `Styles.PointLabelStyles` | **null** |

So any workflow that needs point styles or label styles has to go through a `NETLOAD`ed
.NET addin. There is no COM path.

## Getting results back out

`SendCommand` is fire-and-forget — no return value, no stdout. The reliable trick is to
have the addin (or LISP) write to a file the caller polls:

```csharp
var sw = new StreamWriter(Path.Combine(OutDir, "result.out"), false);
```

**AutoLISP `setenv` does not reach .NET's `Environment`.** Passing paths via environment
variables silently fails; the addin sees `null` and falls back. Use a config file next to
the assembly instead.

## .NET API landmarks that are easy to get wrong

Discovered by reflecting over `AeccDbMgd.dll` with `MetadataLoadContext` (works offline —
you do not need Civil 3D running to read its metadata):

```csharp
// static accessor taking a Database, NOT a property on CivilDocument
PointDescriptionKeySetCollection.GetPointDescriptionKeySets(db)
PointFileFormatCollection.GetPointFileFormats(db)
CogoPointCollection.ImportPoints(file, fmt, false, false, false)   // static

// PointStyle marker is flat properties, not a sub-object
ps.MarkerType = PointMarkerDisplayType.UseSymbolForMarker;  // Use{Point,Custom,Symbol}ForMarker
ps.MarkerSymbolName = "srv062";                             // an AutoCAD block name
ps.CustomMarkerStyle = CustomMarkerType.CustomMarkerX;      // Dot/Blank/Plus/X/VLine
ps.CustomMarkerSuperimposeStyle = CustomMarkerSuperimposeType.Circle;  // None/Square/Circle/SquareCircle
```

`PointFileFormatCollection` enumerates **`PointFileFormat` objects**, not `ObjectId`s —
unlike almost every other Civil 3D collection.

`PointDescriptionKeySetCollection` exposes **`SearchOrder`** (an `ObjectIdCollection`),
which is how you make your key set win over the template's stock one.

### Label style field syntax

Not documented anywhere obvious. Read it off the stock styles that ship in the template:

```
<[Point Number(Sn)]>
<[Point Elevation(Uft|P2|RN|AP|Sn|OF)]>
<[Full Description(CP)]>
<[Raw Description(CP)]>
```

Stock styles use *Full* Description. If you need the raw field code, you must author your
own styles.

## Things that crash the host

These take the whole application down rather than throwing, so budget for restarts.

**1. Creating/configuring a paper-space `Viewport` through .NET while that layout is
current.** Reproduced three times, dying at the identical point. Setting
`LayoutManager.Current.CurrentLayout = name` and then erasing entities and setting
`vp.On = true` inside one transaction triggers a regen of the displayed layout mid-edit.

Use the `MVIEW` command instead and let AutoCAD own the viewport.

**2. Erasing paper-space viewport #1.** Iterating a layout's `BlockTableRecord` exposes the
overall paper-space viewport, which must never be erased — doing so corrupts the layout,
and the drawing then **crashes on open**. `ERASE ALL` from the command line cannot select
it, which is why the command-line route is safe and the .NET route is not:

```csharp
var vp = e as Viewport;
if (vp != null && vp.Number == 1) continue;   // leave it alone
```

**3. `PlotSettingsValidator.SetPlotCentered`** throws `eInvalidInput` when the plot type is
`Layout`. Only valid for `Extents`/`Window`/etc.

**4. `PlotFactory`/`PlotEngine`** is crash-prone when driven from a `SendCommand` context.
`-PLOT` with `BACKGROUNDPLOT=0` is slower to script but fails with a message instead.

### Recover after a crash

A crash-written DWG may be structurally damaged even though its header is intact and it
opens in a hex editor as a valid `AC1032`. Prefer a normally-saved `.bak`. Note that
`RECOVER` **cannot be driven by `SendCommand`** — it spawns a new document context and the
call never completes; it also leaves the command line at a prompt, after which AutoCAD
rejects all COM calls with `RPC_E_CALL_REJECTED`.

To tell a busy AutoCAD from a deadlocked one, sample CPU rather than trusting
`Responding`, which stays `True` in both cases:

```powershell
$c1 = $p.CPU; Start-Sleep 6; $p.Refresh()
# < ~0.15 CPU-seconds per 6s wall => idle/deadlocked, not working
```

## Loading the addin without weakening security

`SECURELOAD` defaults to blocking `NETLOAD` from untrusted paths. Do **not** set it to 0 —
add the build folder to `TRUSTEDPATHS` instead, which whitelists one directory and leaves
verification on:

```powershell
$tp = [string]$doc.GetVariable('TRUSTEDPATHS')
$doc.SetVariable('TRUSTEDPATHS', "$tp;$binDir")
```

AutoCAD holds a lock on a loaded assembly for the life of the session, so an edit-rebuild
loop needs a **new assembly name per build** (or an app restart).

### Skip NETLOAD entirely: an ApplicationPlugins bundle

Once the addin is stable, registering it with the autoloader removes the `NETLOAD` /
`TRUSTEDPATHS` dance from every session. Drop a folder into
`%APPDATA%\Autodesk\ApplicationPlugins\YourApp.bundle`:

```
YourApp.bundle\
  PackageContents.xml
  Contents\          <- the build output
```

```xml
<ComponentEntry AppName="Civil3dAutomation" Version="1.0.0"
                ModuleName="./Contents/Civil3dAutomation.dll"
                LoadOnAutoCADStartup="False"
                LoadOnCommandInvocation="True">
  <Commands GroupName="C3DAUTO">
    <Command Global="C3DINFO" Local="C3DINFO" />
  </Commands>
</ComponentEntry>
```

`LoadOnAutoCADStartup="False"` with `LoadOnCommandInvocation="True"` is the combination
worth having: the commands are registered at startup but the DLL is **not loaded until one
is actually typed**, so the addin costs nothing in a normal session. Verified: Civil 3D
still starts in 6 s with the bundle installed, and `C3DINFO` resolves with no `NETLOAD` and
no `TRUSTEDPATHS` entry.

Two practical notes:

- Make `Contents` a **directory junction** to the build output
  (`New-Item -ItemType Junction`) rather than a copy, so a rebuild propagates instead of
  the bundle silently going stale.
- A new `[CommandMethod]` must also be added to `<Commands>` **and Civil 3D restarted**, or
  the autoloader has no reason to demand-load it. `PackageContents.xml` must be UTF-8
  **without BOM**.

Uninstall is deleting the one folder, which also makes "is the bundle to blame?" a cheap
experiment — see below. **Careful with the junction:** `Remove-Item -Recurse` follows it
and wipes the build output it points at. Delete the junction itself with the
non-recursive `[System.IO.Directory]::Delete($path)` first, then the rest of the folder.

This recipe is now scripted: `scripts/install-bundle.ps1` creates the junction, writes
`PackageContents.xml` (all three commands registered, UTF-8 without BOM) and
`-Uninstall` removes the bundle without touching the build output.

## Civil 3D will not start: check licensing before blaming a plug-in

**Symptom:** `acad.exe` is in the process list but sits at roughly **32 MB with no window
and almost no CPU**, and COM never becomes available. It never gets as far as opening a
drawing.

That is the licensing/identity handshake, not the drawing and not an addin. It follows
`Stop-Process -Force` on Civil 3D: force-killing leaves Autodesk's identity stack wedged.
The tell is `AdskIdentityManager` burning huge CPU — observed at **991 CPU-seconds** and
still climbing — while `acad.exe` itself is idle.

These are user-level helpers that Autodesk respawns on demand; the licence is untouched:

```powershell
Get-Process acad -EA SilentlyContinue | Stop-Process -Force
foreach ($n in 'AdskIdentityManager','AdskAccessUIHost','AdskAccessCore') {
    Get-Process $n -EA SilentlyContinue | Stop-Process -Force
}
Start-Sleep 8    # AdskIdentityManager should come back at ~0s CPU
```

Civil 3D then started in 18 s, and 6 s on the following run.

**Diagnose in this order** — cheapest and most likely first:

1. `acad.exe` at ~32 MB with no window → licensing. Bounce the helpers above.
2. `%LOCALAPPDATA%\Autodesk\C3D <ver>\Logs\AeccLog-<date>.log` for the last drawing it
   really opened, and the plugin log for initialised/terminated pairs — a clean init
   followed seconds later by a clean termination means it started and *quit*, not hung.
3. Only then suspect an `ApplicationPlugins` bundle, and test it by **moving the bundle
   aside and relaunching** rather than reasoning about it.

That ordering is written from getting it backwards: a freshly installed bundle was assumed
to be the cause, and removing it changed nothing — Civil 3D still would not start, because
the real problem was licensing. Two launch cycles wasted on the wrong suspect.

**Prefer a graceful close.** Use COM `Documents.Close()` / quit rather than
`Stop-Process -Force` unless the process is genuinely deadlocked. Force-killing is what
causes this, and it also strands `.dwl`/`.dwl2` lock files beside the drawing.

## Target framework

AutoCAD/Civil 3D 2027 hosts **.NET 10** (`coreclr.dll 10.0` in the process). Build addins
as `net10.0-windows` with `EnableDynamicLoading`, referencing `accoremgd`, `acdbmgd`,
`acmgd`, `AeccDbMgd` (and `AecBaseMgd` from the `ACA` subfolder) with `Private=false`.
`csc.exe` from the .NET Framework directory is the wrong compiler.
