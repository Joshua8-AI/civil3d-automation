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

Not automated. The harness functions are exercised by hand: `Get-C3DApp`,
`Initialize-C3DDocument`, `Invoke-C3DNetload`, then `Invoke-C3DCommand C3DINFO` and
check `out\c3dinfo.out` ends with `done` (on an error it now ends with an `ERROR …`
line **and** `done`, and `Invoke-C3DCommand` raises a non-terminating error).

Restart Civil 3D after (re)installing the bundle; a session started while the bundle
was absent does not register it.
