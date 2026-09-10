<#
.SYNOPSIS
  Drive a running Civil 3D / AutoCAD session from Windows PowerShell.

.NOTES
  MUST run under powershell.exe (Windows PowerShell 5.1).
  PowerShell 7 removed [Marshal]::GetActiveObject, so `pwsh` cannot attach at all.
#>

function Get-C3DApp {
    <#  Attach to the running AutoCAD/Civil 3D. Throws if it isn't up.  #>
    [CmdletBinding()]
    param()
    try {
        [Runtime.InteropServices.Marshal]::GetActiveObject('AutoCAD.Application')
    } catch {
        throw "Could not attach to AutoCAD. Is it running, and are you under powershell.exe (not pwsh)? $($_.Exception.Message)"
    }
}

function Get-C3DAecc {
    <#  The Civil 3D COM object model. ProgID is version stamped (13.9 = C3D 2027).
        Look yours up under HKLM:\SOFTWARE\Classes\AeccXUiLand.AeccApplication*  #>
    [CmdletBinding()]
    param(
        [object] $App,
        [string] $ProgId = 'AeccXUiLand.AeccApplication.13.9'
    )
    if (-not $App) { $App = Get-C3DApp }
    $App.GetInterfaceObject($ProgId)
}

function Ensure-C3DDocument {
    <#  The MCP plug-in deadlocks permanently when zero drawings are open, and several
        APIs need a document context. Open one through COM before anything else.  #>
    [CmdletBinding()]
    param(
        [object] $App,
        [string] $TemplatePath
    )
    if (-not $App) { $App = Get-C3DApp }
    if ($App.Documents.Count -eq 0) {
        if ($TemplatePath) { $null = $App.Documents.Add($TemplatePath) }
        else { $null = $App.Documents.Add() }
        Start-Sleep -Seconds 5
    }
    $App.ActiveDocument
}

function Add-C3DTrustedPath {
    <#  Let NETLOAD accept an assembly from $Path WITHOUT weakening SECURELOAD.
        Do not set SECURELOAD=0 - that disables verification globally.  #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [object] $Doc
    )
    if (-not $Doc) { $Doc = (Get-C3DApp).ActiveDocument }
    $winPath = $Path.Replace([char]47, [char]92)
    $tp = [string]$Doc.GetVariable('TRUSTEDPATHS')
    if ($tp -notlike "*$winPath*") {
        $Doc.SetVariable('TRUSTEDPATHS', $(if ($tp) { "$tp;$winPath" } else { $winPath }))
    }
    [string]$Doc.GetVariable('TRUSTEDPATHS')
}

function Invoke-C3DNetload {
    <#  Load a .NET add-in. AutoCAD locks the assembly for the session, so during an
        edit/rebuild loop give each build a NEW assembly name.  #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Dll,
        [object] $Doc
    )
    if (-not $Doc) { $Doc = (Get-C3DApp).ActiveDocument }
    $null = Add-C3DTrustedPath -Path (Split-Path $Dll -Parent) -Doc $Doc
    $Doc.SendCommand('(command "_.NETLOAD" "' + $Dll.Replace([char]92, [char]47) + '")(princ) ')
    Start-Sleep -Seconds 4
}

function Invoke-C3DCommand {
    <#
      SendCommand is fire-and-forget: no return value, no stdout. The reliable pattern is
      to have the add-in (or LISP) write a log file, then poll for a sentinel string.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Command,
        [string] $LogFile,
        [string] $DoneMarker = 'done',
        [int]    $TimeoutSec = 120,
        [object] $Doc
    )
    if (-not $Doc) { $Doc = (Get-C3DApp).ActiveDocument }
    if ($LogFile) { Remove-Item $LogFile -ErrorAction SilentlyContinue }

    $Doc.SendCommand("$Command ")

    if (-not $LogFile) { return }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $LogFile) {
            $c = Get-Content $LogFile -Raw
            if ($c -match [regex]::Escape($DoneMarker)) { return $c }
        }
    }
    Write-Warning "timed out after ${TimeoutSec}s waiting for '$DoneMarker' in $LogFile"
    if (Test-Path $LogFile) { Get-Content $LogFile -Raw }
}

function Test-C3DBusy {
    <#
      Distinguish "working hard" from "deadlocked". Process.Responding reports True in
      BOTH cases, so sample CPU instead: under ~0.15 CPU-seconds per 6s wall clock the
      process is idle, not busy.
    #>
    [CmdletBinding()]
    param([int] $SampleSeconds = 6)
    $p = Get-Process acad -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { return [pscustomobject]@{ Running = $false } }
    $c1 = $p.CPU
    Start-Sleep -Seconds $SampleSeconds
    $p.Refresh()
    $delta = $p.CPU - $c1
    [pscustomobject]@{
        Running    = $true
        Pid        = $p.Id
        Responding = $p.Responding
        CpuDelta   = [math]::Round($delta, 2)
        Busy       = ($delta -ge 0.15)
        WorkingSet = [math]::Round($p.WorkingSet64 / 1MB)
    }
}

function Reset-C3DCommandLine {
    <#
      Clear a stuck command prompt. Once AutoCAD is sitting at a prompt it rejects COM
      calls with RPC_E_CALL_REJECTED, and COM cannot clear it - only real keystrokes can.
    #>
    [CmdletBinding()]
    param([int] $Count = 5)
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class C3DFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@ -ErrorAction SilentlyContinue
    $p = Get-Process acad -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { Write-Warning 'acad not running'; return }
    [void][C3DFg]::ShowWindow($p.MainWindowHandle, 9)
    [void][C3DFg]::SetForegroundWindow($p.MainWindowHandle)
    Start-Sleep -Milliseconds 800
    $ws = New-Object -ComObject WScript.Shell
    1..$Count | ForEach-Object { $ws.SendKeys('{ESC}'); Start-Sleep -Milliseconds 300 }
}

Export-ModuleMember -Function Get-C3DApp, Get-C3DAecc, Ensure-C3DDocument,
    Add-C3DTrustedPath, Invoke-C3DNetload, Invoke-C3DCommand, Test-C3DBusy,
    Reset-C3DCommandLine
