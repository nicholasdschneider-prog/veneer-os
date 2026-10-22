$ErrorActionPreference='Stop'
$b='C:\Users\nicho\backups\hermes-final-20261016';$r=Join-Path $b 'quiescent-r3-20261022';$src=Join-Path $b 'archive-quiescent-r3.py';$j=Join-Path $b 'quiescent-r3-launch-20261022.json'
if((Test-Path $j) -or (Test-Path (Join-Path $r 'refresh-status-started.json'))){throw 'Launch evidence exists: inspect, never replay'}
if(@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match 'hermes-final-20261016\\archive-(?:reserved-reconcile|quiescent(?:-resume|-r3)?)\.py'}).Count){throw 'Operator controller still live'}
$sha=(Get-FileHash $src).Hash
if($sha -ne 'FA41B3287CDF40841F23729964D28342AF5A7A3D42F43E8993100356BF2F2A65'){throw 'Source mismatch'}
$p=Get-Content (Join-Path $r 'refresh-preflight.json') -Raw|ConvertFrom-Json
if($p.source_sha256 -ne $sha -or $p.reconciliation_rows -ne 2386571 -or $p.correction_count -ne 1 -or $p.negative_unapproved_mismatch_checks -ne 3){throw 'Preflight identity/count gate'}
foreach($k in @('original_records_preserved','snapshot_checks_all259_ok','reserved_source_mirror_history54bytes_sha_match','path_access_regression_integrity_ok','sqlite_header_detection_ok')){if(-not $p.$k){throw "Preflight gate $k"}}
if($p.guard.enabled_cron -or $p.guard.enabled_tasks -or $p.guard.processes -or $p.guard.active_startup){throw 'Quiescence gate'}
if((Get-FileHash (Join-Path $r 'baseline-corrections.jsonl')).Hash -ne $p.correction_sha256){throw 'Correction checksum gate'}
$journal=@{state='launch_intent';at=(Get-Date).ToUniversalTime().ToString('o');source=$src;source_sha256=$sha;launch_attempts=1;both_stopped_attempts_preserved=$true;final_seal=$false;correction_sha256=$p.correction_sha256;reconciliation_sha256=(Get-FileHash (Join-Path $r 'reconciliation.json')).Hash;preflight_sha256=(Get-FileHash (Join-Path $r 'refresh-preflight.json')).Hash;reconciled_rows=2386571}
$s=[IO.File]::Open($j,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$bytes=[Text.Encoding]::UTF8.GetBytes(($journal|ConvertTo-Json));$s.Write($bytes,0,$bytes.Length)}finally{$s.Dispose()}
$res=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('C:\Python314\python.exe "'+$src+'"');CurrentDirectory=$b}
$journal.return_value=$res.ReturnValue;$journal.pid=$res.ProcessId
if($res.ReturnValue -eq 0){$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$($res.ProcessId)";$journal.created=$proc.CreationDate.ToString('o');$journal.parent=$proc.ParentProcessId;$journal.state='launched'}else{$journal.state='launch_failed'}
$journal|ConvertTo-Json|Set-Content $j -Encoding UTF8
$journal|ConvertTo-Json
