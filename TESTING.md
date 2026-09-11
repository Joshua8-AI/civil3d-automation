# Testing record

How this repo is verified, and the last recorded results (2026-09-11, `main`).

## Offline (Civil 3D closed)

| check | command | last result |
|---|---|---|
| Add-in compiles | `dotnet build src\Civil3dAutomation\Civil3dAutomation.csproj -c Release` | 0 warnings, 0 errors |
| Config parsing | `dotnet test tests\Civil3dAutomation.Tests` | 8 passed |
| Harness | `Invoke-Pester -Path tests -CI` under both `pwsh` and `powershell.exe` | 10 passed in each |
| Lint | `Invoke-ScriptAnalyzer -Path . -Recurse` | 0 findings |
| Ignore rules | `git check-ignore -v src/Civil3dAutomation/c3d.paths.txt` matches; `c3d.paths.txt.example` does not | as expected |
| Bundle install/uninstall | `scripts\install-bundle.ps1`, then `-Uninstall` | junction created then removed; `bin\Release\net10.0-windows\Civil3dAutomation.dll` still present afterwards |

Baseline before the improvement pass: no tests at all; PSScriptAnalyzer reported 2
warnings (unapproved `Ensure-` verb, missing `ShouldProcess`) and 8 comment-help infos.

Notes:

- The Pester `Get-C3DApp` fail-fast tests skip themselves when `acad.exe` is running
  (they'd attach to it), so run them with Civil 3D closed for full coverage — the CI
  summary shows `Skipped: 2` otherwise.
- `Invoke-ScriptAnalyzer` crashes roughly one run in four with a null-reference from
  `PSProvideCommentHelp` racing `Export-ModuleMember` (PSScriptAnalyzer #1538 /
  PowerShell #13127). Re-run it; when it completes it reports zero findings. Passing
  `-ExcludeRule PSProvideCommentHelp` avoids the race entirely.
- The xunit project compiles only `Config.cs`, which has no Autodesk dependency by
  design; everything else in the add-in needs the live application.

## Live (Civil 3D open)

Not automated; driven through the harness under `powershell.exe`. Last run
2026-09-11 on Civil 3D 2027, fresh session after `scripts\install-bundle.ps1`:

| step | result |
|---|---|
| `Get-C3DApp` → `Initialize-C3DDocument` | attached, `Drawing1.dwg` |
| `Invoke-C3DCommand C3DINFO -LogFile out\c3dinfo.out` | returned in 1 s, 47 lines (24 point styles …), ends with `done`, no `ERROR`/`FATAL` |
| `Invoke-C3DCommand C3DAPI -LogFile out\c3dapi.out` | returned in 1 s, 73 lines (`PointStyle` properties and methods), ends with `done` |
| which DLL the process loaded | `%APPDATA%\Autodesk\ApplicationPlugins\Civil3dAutomation.bundle\Contents\Civil3dAutomation.dll` — demand-loaded by the first command via the bundle's `LoadOnCommandInvocation`, no NETLOAD |

On an error the log now ends with an `ERROR …` line **and** `done`, and
`Invoke-C3DCommand` raises a non-terminating error instead of waiting out the timeout.

Restart Civil 3D after (re)installing the bundle; a session started while the bundle
was absent does not register it. From a script, launch with the shortcut's arguments
(`acad.exe /ld "…\AecBase.dbx" /p "<<C3D_Imperial>>" /product C3D /language en-US`);
expect a transient message box and ~3 minutes before the session is usable.
