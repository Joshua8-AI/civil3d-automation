<#
.SYNOPSIS
  Installs the add-in as an Autodesk ApplicationPlugins bundle (demand-loaded).

.DESCRIPTION
  Bundles under %APPDATA%\Autodesk\ApplicationPlugins are Autodesk's supported
  deployment path and are implicitly trusted, so this removes the NETLOAD /
  TRUSTEDPATHS dance from every session. The commands are registered with
  LoadOnAutoCADStartup="False" and LoadOnCommandInvocation="True": Civil 3D knows
  the command names at startup but does not load the DLL until one is typed, so the
  add-in costs nothing in a normal session.

  Contents\ is a directory JUNCTION to the build output, not a copy, so a rebuild
  propagates instead of the bundle silently going stale.

  Installs per-user under %APPDATA%; no elevation is required.

.PARAMETER SourceDir
  Build output folder to junction to. Defaults to
  src\Civil3dAutomation\bin\Release\net10.0-windows.

.PARAMETER BundleRoot
  ApplicationPlugins folder. Defaults to the per-user one under %APPDATA%.

.PARAMETER BundleName
  Bundle folder name. Defaults to Civil3dAutomation.bundle.

.PARAMETER Uninstall
  Remove the bundle. The junction is deleted non-recursively so the build output it
  points at is left untouched.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string] $SourceDir,
  [string] $BundleRoot = (Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins'),
  [string] $BundleName = 'Civil3dAutomation.bundle',
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent $PSScriptRoot
$bundleDir = Join-Path $BundleRoot $BundleName
$contents  = Join-Path $bundleDir 'Contents'
$manifest  = Join-Path $bundleDir 'PackageContents.xml'

# Stable GUIDs so reinstalls upgrade in place rather than registering a duplicate.
# Generated once with New-Guid; do not regenerate.
$ProductCode = '{25A91E4E-5454-4EF5-82EC-D1B15E80CD80}'
$UpgradeCode = '{EF304C91-3872-4490-AB85-38E2A150E8A2}'

# A running Civil 3D holds a lock on the loaded DLL. Probe the actual file locks
# rather than matching acad.exe by name: plain AutoCAD uses the same executable and
# does not load this bundle. Contents is a junction, so a non-recursive listing of
# it reaches the build output's DLLs directly.
function Get-LockedBundleFile([string] $dir) {
  if (-not (Test-Path $dir)) { return $null }
  foreach ($f in Get-ChildItem $dir -File -Filter *.dll -ErrorAction SilentlyContinue) {
    $fs = $null
    try {
      $fs = [System.IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None')
    } catch [System.IO.IOException] {
      return $f.FullName
    } catch [System.UnauthorizedAccessException] {
      return $f.FullName
    } finally {
      if ($fs) { $fs.Dispose() }
    }
  }
  return $null
}

function Remove-Junction {
  # A recursive Remove-Item FOLLOWS a junction and deletes the target's contents,
  # which here is the build output. Directory.Delete(path) without the recursive
  # flag removes only the reparse point.
  [CmdletBinding(SupportsShouldProcess)]
  param([Parameter(Mandatory)] [string] $Path)
  $item = Get-Item $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "'$Path' is a real directory, not a junction; refusing to delete it. Remove the bundle by hand."
  }
  if ($PSCmdlet.ShouldProcess($Path, 'delete junction (target untouched)')) {
    [System.IO.Directory]::Delete($Path)
  }
}

$locked = Get-LockedBundleFile $contents
if ($locked) {
  throw "'$locked' is loaded by a running Civil 3D. Close it completely, then re-run."
}

if ($Uninstall) {
  if (Test-Path $bundleDir) {
    if ($PSCmdlet.ShouldProcess($bundleDir, 'remove bundle')) {
      Remove-Junction -Path $contents
      if (Test-Path $manifest) { Remove-Item $manifest -Force }
      $left = @(Get-ChildItem $bundleDir -Force)
      if ($left.Count -gt 0) {
        throw "Unexpected items left in $bundleDir ($($left.Name -join ', ')); not deleting it."
      }
      Remove-Item $bundleDir -Force
      Write-Output "Removed $bundleDir"
    }
  } else {
    Write-Output "Nothing to remove at $bundleDir"
  }
  Write-Output 'Restart Civil 3D for the change to take effect.'
  exit 0
}

if (-not $SourceDir) {
  $SourceDir = Join-Path $repoRoot 'src\Civil3dAutomation\bin\Release\net10.0-windows'
}
$dll = Join-Path $SourceDir 'Civil3dAutomation.dll'
if (-not (Test-Path $dll)) {
  throw "Add-in not built at '$dll'. Run: dotnet build src\Civil3dAutomation -c Release"
}
$SourceDir = (Resolve-Path $SourceDir).Path

if ($PSCmdlet.ShouldProcess($bundleDir, "install bundle (Contents -> $SourceDir)")) {
  New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null

  # Re-point an existing junction rather than failing on it; refuse a real directory.
  if (Test-Path $contents) { Remove-Junction -Path $contents }
  New-Item -ItemType Junction -Path $contents -Target $SourceDir | Out-Null

  $appVersion = (Get-Item $dll).VersionInfo.FileVersion
  if (-not $appVersion) { $appVersion = '1.0.0.0' }

  $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<ApplicationPackage
  SchemaVersion="1.0"
  AppVersion="$appVersion"
  Author="Joshua8-AI"
  ProductCode="$ProductCode"
  UpgradeCode="$UpgradeCode"
  Name="Civil 3D Automation"
  PreferNewestAcross="AppData|ProgramFiles"
  >
  <CompanyDetails Name="Joshua8-AI" Url="https://github.com/Joshua8-AI/civil3d-automation" Email="" />
  <RuntimeRequirements Platform="Civil3D" SeriesMin="R26.0" SeriesMax="R26.0" OS="Win64" SupportPath="./Contents" />
  <Components>
    <ComponentEntry AppName="Civil3dAutomation" ModuleName="./Contents/Civil3dAutomation.dll"
                    LoadOnAutoCADStartup="False" LoadOnCommandInvocation="True"
                    AppDescription="Civil 3D survey setup and reconnaissance commands">
      <Commands GroupName="C3DAUTO">
        <Command Global="C3DINFO" Local="C3DINFO" />
        <Command Global="C3DAPI" Local="C3DAPI" />
        <Command Global="C3DSURVEYSETUP" Local="C3DSURVEYSETUP" />
      </Commands>
    </ComponentEntry>
  </Components>
  <DisplayInAppManager>true</DisplayInAppManager>
</ApplicationPackage>
"@

  # PackageContents.xml must be UTF-8 without BOM or AutoCAD ignores the bundle.
  [System.IO.File]::WriteAllText($manifest, $xml, (New-Object System.Text.UTF8Encoding($false)))

  Write-Output "Installed bundle: $bundleDir"
  Write-Output "  PackageContents.xml  (AppVersion $appVersion; commands C3DINFO, C3DAPI, C3DSURVEYSETUP)"
  Write-Output "  Contents\            -> junction to $SourceDir"
  Write-Output ''
  Write-Output 'Close Civil 3D COMPLETELY and reopen it. The commands are registered at startup'
  Write-Output 'and the DLL loads the first time one is typed; no NETLOAD, no TRUSTEDPATHS entry.'
  Write-Output 'A new [CommandMethod] must be added to <Commands> here and Civil 3D restarted.'
}
