$ErrorActionPreference='Stop'
$root='C:\Users\nicho\backups\hermes-final-20261016'
$checks=Get-Content "$root\sqlite-checks.json" -Raw|ConvertFrom-Json
$bad=@($checks|Where-Object {$_.error_type -or ($_.sqlite -eq $true -and $_.integrity_ok -ne $true)})
$logs=@(Get-ChildItem "$root\robocopy-*.log"|ForEach-Object {
 $s=Get-Content -LiteralPath $_.FullName -Raw
 [pscustomobject]@{name=$_.Name;bytes=$_.Length;error_codes=@([regex]::Matches($s,'(?i)ERROR\s+(\d+)')|ForEach-Object {$_.Groups[1].Value});privilege_signal=($s -match 'privilege');link_signal=($s -match 'symbolic|junction|reparse');access_denied_signal=($s -match 'Access is denied');missing_signal=($s -match 'cannot find|not found');retry_limit_signal=($s -match 'RETRY LIMIT EXCEEDED')}
})
[pscustomobject]@{at=(Get-Date -Format o);sqlite_count=@($checks|Where-Object {$_.sqlite -eq $true}).Count;sqlite_integrity_ok=@($checks|Where-Object {$_.integrity_ok -eq $true}).Count;sqlite_failed_metadata=$bad;copy_log_classification=$logs}|ConvertTo-Json -Depth 8
