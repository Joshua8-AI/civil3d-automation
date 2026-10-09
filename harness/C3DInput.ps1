<#
.SYNOPSIS
  Drive Civil 3D modal dialogs and command prompts without COM (dot-source this file).

.DESCRIPTION
  While a Civil 3D command is waiting for input, every COM call (including
  SendCommand and GetVariable) fails with RPC_E_CALL_REJECTED, and Civil 3D's own
  dialogs (Create Grading Group, Select Surface, Auto-Balance Volumes, ...) are plain
  Win32 #32770 dialogs that UI Automation only exposes as unnamed panes. These helpers
  work through window messages instead, so they also work while the Windows session
  is locked (no SendKeys, no screen capture needed).

  To read the prompt a command is waiting at, set LOGFILEMODE=1 beforehand and read the
  file named by LOGFILENAME; it is flushed one prompt behind the input.

  MUST run under powershell.exe (Windows PowerShell 5.1) like the rest of the harness.
#>

if (-not ('C3DInputW32' -as [type])) {
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class C3DInputW32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l,t,r,b; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rc; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO g);
  public static string Text(IntPtr h){ var s=new StringBuilder(512); GetWindowText(h,s,512); return s.ToString(); }
  public static string Cls(IntPtr h){ var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
  public static List<IntPtr> TopLevel(uint pid){ var r=new List<IntPtr>(); EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)) r.Add(h); return true;}, IntPtr.Zero); return r; }
  public static List<IntPtr> Children(IntPtr p){ var r=new List<IntPtr>(); EnumChildWindows(p,(h,l)=>{ r.Add(h); return true;}, IntPtr.Zero); return r; }
}
"@
}

function Get-C3DAcadPid { [uint32](Get-Process acad | Select-Object -First 1).Id }

function Get-C3DDialog {
    <# .SYNOPSIS Wait for a visible #32770 dialog of acad.exe whose title matches -TitleLike; returns its hwnd or 0. #>
    param([Parameter(Mandatory)] [string] $TitleLike, [int] $TimeoutSec = 20)
    $acadPid = Get-C3DAcadPid
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        foreach ($h in [C3DInputW32]::TopLevel($acadPid)) {
            if ([C3DInputW32]::Cls($h) -eq '#32770' -and [C3DInputW32]::Text($h) -like $TitleLike) { return $h }
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    [IntPtr]::Zero
}

function Show-C3DDialogControls {
    <# .SYNOPSIS List control id, class and text of every child of a dialog (use it to find ids). #>
    param([Parameter(Mandatory)] [IntPtr] $Dialog)
    foreach ($c in [C3DInputW32]::Children($Dialog)) {
        '{0,10} {1,-16} "{2}"' -f [C3DInputW32]::GetDlgCtrlID($c), [C3DInputW32]::Cls($c), [C3DInputW32]::Text($c)
    }
}

function Get-C3DControl([IntPtr] $Dialog, [int] $Id) {
    foreach ($c in [C3DInputW32]::Children($Dialog)) { if ([C3DInputW32]::GetDlgCtrlID($c) -eq $Id) { return $c } }
    [IntPtr]::Zero
}

function Set-C3DControlText { param([IntPtr] $Dialog, [int] $Id, [string] $Text)
    [void][C3DInputW32]::SendMessage((Get-C3DControl $Dialog $Id), 0x000C, [IntPtr]::Zero, $Text)   # WM_SETTEXT
}

function Set-C3DCheckBox { param([IntPtr] $Dialog, [int] $Id, [bool] $On)
    # Civil 3D often labels a check box with a separate static; the real check box is the
    # Button that carries the caption text (e.g. "Automatic surface creation").
    $c = Get-C3DControl $Dialog $Id
    $checked = [int][C3DInputW32]::SendMessage($c, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero) -eq 1        # BM_GETCHECK
    if ($checked -ne $On) { [void][C3DInputW32]::SendMessage($c, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) } # BM_CLICK
}

function Invoke-C3DControl { param([IntPtr] $Dialog, [int] $Id)
    # PostMessage, not SendMessage: clicking OK on a modal dialog must not block the caller.
    [void][C3DInputW32]::PostMessage((Get-C3DControl $Dialog $Id), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}

function Send-C3DInput {
    <#
    .SYNOPSIS
      Type into the Civil 3D command line by posting WM_CHAR to acad's keyboard-focus window.
    .DESCRIPTION
      Works while a command rejects COM. "\n" in -Text means Enter. -Escape N posts N ESC
      keystrokes first (cancels a stuck command). Typed coordinates pick objects, but a
      (handent "...") expression at a Civil 3D "Select the feature:" prompt is accepted
      and then the command silently ends - pick by a point on the object instead.
    #>
    param([string] $Text, [int] $Escape = 0)
    $p = Get-Process acad | Select-Object -First 1
    $x = 0
    $tid = [C3DInputW32]::GetWindowThreadProcessId($p.MainWindowHandle, [ref]$x)
    $g = New-Object C3DInputW32+GUITHREADINFO
    $g.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($g)
    [void][C3DInputW32]::GetGUIThreadInfo($tid, [ref]$g)
    $t = if ($g.hwndFocus -ne [IntPtr]::Zero) { $g.hwndFocus } else { $p.MainWindowHandle }
    for ($i = 0; $i -lt $Escape; $i++) {
        [void][C3DInputW32]::PostMessage($t, 0x0100, [IntPtr]0x1B, [IntPtr]0x00010001)
        [void][C3DInputW32]::PostMessage($t, 0x0102, [IntPtr]27, [IntPtr]0x00010001)
        [void][C3DInputW32]::PostMessage($t, 0x0101, [IntPtr]0x1B, [IntPtr]0xC0010001)
        Start-Sleep -Milliseconds 300
    }
    if ($Text) {
        foreach ($ch in $Text.Replace('\n', "`r").ToCharArray()) {
            [void][C3DInputW32]::PostMessage($t, 0x0102, [IntPtr][int]$ch, [IntPtr]0)
            Start-Sleep -Milliseconds 20
        }
    }
}
