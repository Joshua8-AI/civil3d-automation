<#
.SYNOPSIS
  Drive a running Civil 3D / AutoCAD session from Windows PowerShell.

.NOTES
  MUST run under powershell.exe (Windows PowerShell 5.1).
  PowerShell 7 removed [Marshal]::GetActiveObject, so `pwsh` cannot attach at all.
#>

function Get-C3DApp {
    <#
    .SYNOPSIS
      Attach to the running AutoCAD / Civil 3D application object.
    .DESCRIPTION
      Wraps [Marshal]::GetActiveObject('AutoCAD.Application'). Throws with a hint about
      powershell.exe vs pwsh if nothing is running or the call is unavailable.
    #>
    [CmdletBinding()]
    param()
    try {
        [Runtime.InteropServices.Marshal]::GetActiveObject('AutoCAD.Application')
    } catch {
        throw "Could not attach to AutoCAD. Is it running, and are you under powershell.exe (not pwsh)? $($_.Exception.Message)"
    }
}

function Get-C3DAecc {
    <#
    .SYNOPSIS
      Get the Civil 3D COM object model (AeccApplication) from the AutoCAD app object.
    .DESCRIPTION
      The Civil 3D COM ProgID is version stamped (13.9 = Civil 3D 2027). Look yours up
      under HKLM:\SOFTWARE\Classes\AeccXUiLand.AeccApplication* and pass it as -ProgId.
    #>
    [CmdletBinding()]
    param(
        [object] $App,
        [string] $ProgId = 'AeccXUiLand.AeccApplication.13.9'
    )
    if (-not $App) { $App = Get-C3DApp }
    $App.GetInterfaceObject($ProgId)
}

function Initialize-C3DDocument {
    <#
    .SYNOPSIS
      Make sure at least one drawing is open and return the active document.
    .DESCRIPTION
      Civil3D-mcp plug-in builds before Sacred-G/Civil3D-mcp#8 deadlock permanently
      when zero drawings are open (fixed builds fail fast with CIVIL3D.NO_DRAWING and
      can open a drawing themselves), and several APIs need a document context either
      way. Open one through COM before anything else, from -TemplatePath when given,
      otherwise the default template.
      Ensure-C3DDocument is kept as an alias for existing scripts.
    #>
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
    <#
    .SYNOPSIS
      Append a folder to TRUSTEDPATHS so NETLOAD accepts assemblies from it.
    .DESCRIPTION
      Whitelists one directory WITHOUT weakening SECURELOAD. Do not set SECURELOAD=0;
      that disables code-path verification globally. Returns the resulting TRUSTEDPATHS.
    #>
    [CmdletBinding()]
    [OutputType([string])]
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
    <#
    .SYNOPSIS
      NETLOAD a .NET add-in into the running session.
    .DESCRIPTION
      Trusts the DLL's folder first, then sends NETLOAD. AutoCAD locks the assembly for
      the session, so during an edit/rebuild loop give each build a NEW assembly name.
    #>
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
    .SYNOPSIS
      Send a command and, optionally, wait for its log file to report completion.
    .DESCRIPTION
      SendCommand is fire-and-forget: no return value, no stdout. The reliable pattern is
      to have the add-in (or LISP) write a log file, then poll for a sentinel line.
      The sentinel must be a whole line (default 'done'). When the log also contains a
      line starting with ERROR or FATAL, the content is still returned but a
      non-terminating error is raised so callers can catch a failed run with
      -ErrorVariable or -ErrorAction Stop.
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
    # Test first: a silenced Remove-Item failure still lands in the caller's
    # -ErrorVariable, which would make every run on a fresh log path look like an error.
    if ($LogFile -and (Test-Path $LogFile)) { Remove-Item $LogFile -Force }

    $Doc.SendCommand("$Command ")

    if (-not $LogFile) { return }
    $marker = "(?m)^$([regex]::Escape($DoneMarker))\s*$"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $LogFile) {
            $c = Get-Content $LogFile -Raw
            if ($c -match $marker) {
                if ($c -match '(?m)^(ERROR|FATAL)\b') { Write-Error $c -ErrorAction Continue }
                return $c
            }
        }
    }
    Write-Warning "timed out after ${TimeoutSec}s waiting for '$DoneMarker' in $LogFile"
    if (Test-Path $LogFile) { Get-Content $LogFile -Raw }
}

function Get-C3DProcess {
    # Private. Pick the acad.exe to operate on. With several instances running, plain
    # "first one" silently targets the wrong session, so ask for -ProcessId instead.
    [CmdletBinding()]
    param([int] $ProcessId)
    if ($ProcessId) { return Get-Process -Id $ProcessId -ErrorAction Stop }
    $all = @(Get-Process acad -ErrorAction SilentlyContinue)
    if ($all.Count -gt 1) {
        Write-Warning "More than one acad.exe is running (PIDs: $($all.Id -join ', ')). Pass -ProcessId to choose one."
        return $null
    }
    if ($all.Count -eq 1) { return $all[0] }
    return $null
}

function Test-C3DBusy {
    <#
    .SYNOPSIS
      Tell a working AutoCAD from a deadlocked one by sampling CPU.
    .DESCRIPTION
      Process.Responding reports True in BOTH cases, so sample CPU instead: under about
      0.15 CPU-seconds per 6 s of wall clock the process is idle, not busy. Returns
      Running=$false when no acad.exe is found. With several acad.exe instances, pass
      -ProcessId; otherwise a warning is written and Running=$false is returned.
    #>
    [CmdletBinding()]
    param(
        [int] $SampleSeconds = 6,
        [int] $ProcessId
    )
    $p = Get-C3DProcess -ProcessId $ProcessId
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
    .SYNOPSIS
      Clear a stuck AutoCAD command prompt by sending ESC keystrokes.
    .DESCRIPTION
      Once AutoCAD is sitting at a prompt it rejects COM calls with RPC_E_CALL_REJECTED,
      and COM cannot clear it; only real keystrokes can. Brings the acad window to the
      foreground, verifies it actually got there (keystrokes go to whatever window has
      focus), then sends -Count ESC presses. Supports -WhatIf / -Confirm. With several
      acad.exe instances, pass -ProcessId.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [int] $Count = 5,
        [int] $ProcessId
    )
    if (-not ('C3DFg' -as [type])) {
        Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class C3DFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
    }
    $p = Get-C3DProcess -ProcessId $ProcessId
    if (-not $p) { Write-Warning 'acad not running'; return }
    if ($PSCmdlet.ShouldProcess("acad.exe PID $($p.Id)", "send $Count x {ESC}")) {
        [void][C3DFg]::ShowWindow($p.MainWindowHandle, 9)
        [void][C3DFg]::SetForegroundWindow($p.MainWindowHandle)
        Start-Sleep -Milliseconds 800
        if ([C3DFg]::GetForegroundWindow() -ne $p.MainWindowHandle) {
            throw "acad (PID $($p.Id)) did not come to the foreground; not sending keys"
        }
        $ws = New-Object -ComObject WScript.Shell
        1..$Count | ForEach-Object { $ws.SendKeys('{ESC}'); Start-Sleep -Milliseconds 300 }
    }
}

New-Alias -Name Ensure-C3DDocument -Value Initialize-C3DDocument

Export-ModuleMember -Function Get-C3DApp, Get-C3DAecc, Initialize-C3DDocument,
    Add-C3DTrustedPath, Invoke-C3DNetload, Invoke-C3DCommand, Test-C3DBusy,
    Reset-C3DCommandLine -Alias Ensure-C3DDocument
