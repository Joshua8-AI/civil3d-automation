# Cold-start smoke test: exactly what a new session would do.
Import-Module C:\dev\civil3d-automation\harness\C3D.psm1 -Force
"module loaded; exported functions:"
(Get-Command -Module C3D).Name | ForEach-Object { "   $_" }

""
"Test-C3DBusy (no Civil 3D running yet):"
Test-C3DBusy -SampleSeconds 1 | Format-List | Out-String | ForEach-Object { $_.Trim() }

""
"Get-C3DApp with Civil 3D closed should fail cleanly, not hang:"
try { $null = Get-C3DApp; "  !! unexpectedly attached" }
catch { "  OK - clear error: $($_.Exception.Message.Split([char]10)[0])" }
