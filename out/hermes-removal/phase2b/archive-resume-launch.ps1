$ErrorActionPreference='Stop'
$b='C:\Users\nicho\backups\hermes-final-20261016';$r=Join-Path $b 'quiescent-resume-20261021';$src=Join-Path $b 'archive-quiescent-resume.py';$j=Join-Path $b 'quiescent-resume-launch-20261021.json'
if((Test-Path $j) -or (Test-Path (Join-Path $r 'status.json'))){throw 'Prior launch evidence exists; inspect, never replay'}
$live=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match 'hermes-final-20261016\\archive-(?:quiescent|quiescent-resume|resume-reconcile)\.py'})
if($live.Count){throw 'Operator controller still live'}
$sha=(Get-FileHash $src).Hash
if($sha -ne '6328A72B667B621D04511B2214DC7D77A60E3F3DB8D0F78CF746C5819A20924C'){throw 'Source mismatch'}
$rec=Get-Content (Join-Path $r 'reconciliation.json') -Raw|ConvertFrom-Json
$p=Get-Content (Join-Path $r 'preflight.json') -Raw|ConvertFrom-Json
if($rec.state -ne 'reconciled_ready' -or @($rec.unresolved).Count -or $rec.reconciled_rows -ne 1121082 -or -not $rec.original_attempt_preserved){throw 'Reconciliation gate'}
foreach($k in @('syntax_ok','all66captured_snapshots_integrity_ok','failed_265char_snapshot_short_alias_ok','forced_no_8dot3_extended_handle_copy_ok','short_destination_backup_integrity_ok')){if(-not $p.$k){throw "Preflight gate $k"}}
if($p.source_sha256 -ne $sha -or $p.guard.enabled_tasks -or $p.guard.processes -or $p.guard.active_startup -or $p.guard.enabled_cron){throw 'Preflight identity/quiescence gate'}
$journal=@{state='launch_intent';at=(Get-Date).ToUniversalTime().ToString('o');source=$src;source_sha256=$sha;resume_directory=$r;reconciled_rows=$rec.reconciled_rows;original_attempt_preserved=$true;preflight_sha256=(Get-FileHash (Join-Path $r 'preflight.json')).Hash;reconciliation_sha256=(Get-FileHash (Join-Path $r 'reconciliation.json')).Hash;launch_attempts=1;final_seal=$false}
$stream=[IO.File]::Open($j,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$bytes=[Text.Encoding]::UTF8.GetBytes(($journal|ConvertTo-Json -Depth 8));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('C:\Python314\python.exe "'+$src+'"');CurrentDirectory=$b}
$journal.return_value=$result.ReturnValue;$journal.pid=$result.ProcessId
if($result.ReturnValue -eq 0){$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$($result.ProcessId)";$journal.created=$proc.CreationDate.ToString('o');$journal.parent=$proc.ParentProcessId;$journal.state='launched'}else{$journal.state='launch_failed'}
$journal|ConvertTo-Json -Depth 8|Set-Content $j -Encoding UTF8
$journal|ConvertTo-Json -Depth 8
