#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
<#
  Harness tests. Nothing here needs Civil 3D: the COM-facing functions are only
  exercised for their failure path, and Invoke-C3DCommand is driven with a fake
  document whose SendCommand writes the log file the real add-in would write.
  Runs under both pwsh and powershell.exe.
#>

BeforeDiscovery {
    # -Skip is evaluated at discovery time, so this has to be decided here.
    $script:acadRunning = [bool](Get-Process acad -ErrorAction SilentlyContinue)
}

BeforeAll {
    $script:modulePath = Join-Path $PSScriptRoot '..\harness\C3D.psm1'
    $script:expectedFunctions = @(
        'Get-C3DApp', 'Get-C3DAecc', 'Initialize-C3DDocument', 'Add-C3DTrustedPath',
        'Invoke-C3DNetload', 'Invoke-C3DCommand', 'Test-C3DBusy', 'Reset-C3DCommandLine'
    )
    Import-Module $script:modulePath -Force

    # A stand-in for the COM document: SendCommand "runs the command" by writing the
    # given text to the log file, exactly as the add-in's OpenLog/WriteLine would.
    function Get-FakeDocument {
        param([string] $LogFile, [string] $Content)
        $doc = [pscustomobject]@{ LogFile = $LogFile; Content = $Content }
        $doc | Add-Member -MemberType ScriptMethod -Name SendCommand -Value {
            # The command text itself is irrelevant to the fake; only the log matters.
            [System.IO.File]::WriteAllText($this.LogFile, $this.Content)
        }
        return $doc
    }
}

Describe 'C3D module surface' {

    It 'imports without warnings' {
        $warnings = @()
        Import-Module $script:modulePath -Force -WarningVariable warnings -WarningAction SilentlyContinue
        $warnings | Should -BeNullOrEmpty
    }

    It 'exports exactly the eight expected functions' {
        $exported = @((Get-Module C3D).ExportedFunctions.Keys) | Sort-Object
        $exported | Should -Be ($script:expectedFunctions | Sort-Object)
    }

    It 'exports Ensure-C3DDocument as an alias of Initialize-C3DDocument' {
        (Get-Module C3D).ExportedAliases.Keys | Should -Contain 'Ensure-C3DDocument'
        (Get-Alias Ensure-C3DDocument).ResolvedCommand.Name | Should -Be 'Initialize-C3DDocument'
    }

    It 'uses only approved verbs' {
        $approved = (Get-Verb).Verb
        foreach ($name in (Get-Module C3D).ExportedFunctions.Keys) {
            $verb = $name.Split('-')[0]
            $approved | Should -Contain $verb -Because "$name must use an approved verb"
        }
    }
}

Describe 'Without a running AutoCAD' -Skip:$acadRunning {

    It 'Get-C3DApp fails fast with an attach hint' {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        { Get-C3DApp } | Should -Throw -ExpectedMessage '*Could not attach*'
        $sw.Stop()
        $sw.ElapsedMilliseconds | Should -BeLessThan 5000
    }

    It 'Test-C3DBusy reports Running=$false promptly' {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Test-C3DBusy
        $sw.Stop()
        $r.Running | Should -BeFalse
        $sw.ElapsedMilliseconds | Should -BeLessThan 2000
    }
}

Describe 'Invoke-C3DCommand log polling' {

    BeforeEach {
        $script:log = Join-Path $TestDrive ("cmd-{0}.out" -f ([guid]::NewGuid().ToString('N')))
    }

    It 'returns the log once the done marker appears on its own line' {
        $doc = Get-FakeDocument -LogFile $script:log -Content "hello`ndone"
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $out = Invoke-C3DCommand -Command 'C3DINFO' -LogFile $script:log -Doc $doc -TimeoutSec 10
        $sw.Stop()
        $out | Should -Match 'done'
        $out | Should -Match 'hello'
        $sw.ElapsedMilliseconds | Should -BeLessThan 5000 -Because 'the marker is present from the first poll'
    }

    It 'warns about a timeout when the marker never appears' {
        $doc = Get-FakeDocument -LogFile $script:log -Content 'ERROR boom'
        $warnings = @()
        $null = Invoke-C3DCommand -Command 'C3DINFO' -LogFile $script:log -Doc $doc -TimeoutSec 1 `
            -WarningVariable warnings -WarningAction SilentlyContinue
        @($warnings).Count | Should -Be 1
        $warnings[0] | Should -Match 'timed out'
    }

    It 'returns promptly AND raises a non-terminating error when the log reports ERROR' {
        $doc = Get-FakeDocument -LogFile $script:log -Content "ERROR boom`ndone"
        $errors = @()
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $out = Invoke-C3DCommand -Command 'C3DSURVEYSETUP' -LogFile $script:log -Doc $doc -TimeoutSec 10 `
            -ErrorVariable errors -ErrorAction SilentlyContinue
        $sw.Stop()
        $sw.ElapsedMilliseconds | Should -BeLessThan 5000 -Because 'done is present, so it must not wait for the timeout'
        $out | Should -Match 'ERROR boom'
        @($errors).Count | Should -Be 1
        $errors[0].ToString() | Should -Match 'ERROR boom'
    }

    It 'does not accept the marker embedded in another word' {
        $doc = Get-FakeDocument -LogFile $script:log -Content "undone`nabandoned"
        $warnings = @()
        $null = Invoke-C3DCommand -Command 'C3DINFO' -LogFile $script:log -Doc $doc -TimeoutSec 1 `
            -WarningVariable warnings -WarningAction SilentlyContinue
        $warnings[0] | Should -Match 'timed out'
    }
}
