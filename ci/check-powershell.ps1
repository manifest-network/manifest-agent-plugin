# Parse without executing Windows-only credential or ACL operations.
param([string[]]$Path = @("$PSScriptRoot/../scripts/*.ps1", "$PSScriptRoot/*.ps1"))
$ErrorActionPreference = 'Stop'
$files = @(Get-ChildItem -Path $Path -File | Sort-Object FullName -Unique)
if ($files.Count -eq 0) { throw 'No PowerShell scripts found.' }
$failed = $false
foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in $parseErrors) {
        [Console]::Error.WriteLine('{0}:{1}: {2}', $file.FullName, $parseError.Extent.StartLineNumber, $parseError.Message)
        $failed = $true
    }
}
if ($failed) { exit 1 }
Write-Output "PowerShell syntax: $($files.Count) scripts passed."
