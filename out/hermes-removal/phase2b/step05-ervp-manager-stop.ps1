$ConfigBase64='eyJhdCI6ICIyMDI2LTEwLTIxVDE1OjQ5OjU3LjI0NDQzMzgtMDQ6MDAiLCAicHJvZmlsZSI6ICJlcnZwLW1hbmFnZXIiLCAiaG9tZSI6ICJDOlxcVXNlcnNcXG5pY2hvXFxBcHBEYXRhXFxMb2NhbFxcaGVybWVzXFxwcm9maWxlc1xcZXJ2cC1tYW5hZ2VyIiwgImhvbWVfZXhpc3RzIjogdHJ1ZSwgImVuYWJsZWRfY3Jvbl9pZHMiOiBbXSwgInRhc2tzIjogW3sibmFtZSI6ICJIZXJtZXNfRVJWUF9NYW5hZ2VyX1dhdGNoZG9nIiwgImxhc3RfcmVzdWx0IjogMCwgImxhc3RfcnVuIjogIjIwMjYtMTAtMjFUMTU6NDU6MDEuMDAwMDAwMC0wNDowMCIsICJuZXh0X3J1biI6ICIyMDI2LTEwLTIxVDE1OjUwOjAwLjAwMDAwMDAtMDQ6MDAiLCAic3RhdGUiOiAiUmVhZHkiLCAiZW5hYmxlZCI6IHRydWV9XSwgInN0YXJ0dXAiOiBbeyJwYXRoIjogIkM6XFxVc2Vyc1xcbmljaG9cXEFwcERhdGFcXFJvYW1pbmdcXE1pY3Jvc29mdFxcV2luZG93c1xcU3RhcnQgTWVudVxcUHJvZ3JhbXNcXFN0YXJ0dXBcXEhlcm1lc19HYXRld2F5X2VydnAtbWFuYWdlci5jbWQuZGlzYWJsZWQtMjAyNjA3MjItMTUzMTMwIiwgInNoYTI1NiI6ICI1QjZGMUVFQ0JFRUVGQzZBMEJDMTVGRDMwMEM0M0EzMURBNjY2ODA3N0ZBMThEQUI2NTQ0NjkwN0Q4MjA1MDQ1IiwgIm5hbWUiOiAiSGVybWVzX0dhdGV3YXlfZXJ2cC1tYW5hZ2VyLmNtZC5kaXNhYmxlZC0yMDI2MDcyMi0xNTMxMzAiLCAiYnl0ZXMiOiAzMzUsICJhY3RpdmUiOiBmYWxzZX0sIHsicGF0aCI6ICJDOlxcVXNlcnNcXG5pY2hvXFxBcHBEYXRhXFxSb2FtaW5nXFxNaWNyb3NvZnRcXFdpbmRvd3NcXFN0YXJ0IE1lbnVcXFByb2dyYW1zXFxTdGFydHVwXFxIZXJtZXNfR2F0ZXdheV9lcnZwLW1hbmFnZXIudmJzIiwgInNoYTI1NiI6ICI2QTBFRDgwMUVFQUNFRThCOTA1NEY3Mzg5RTUxQTFGNzI5MDhBRkM4Rjc3OTc4ODEyMUQ0NDlGMkNBOTJFODA2IiwgIm5hbWUiOiAiSGVybWVzX0dhdGV3YXlfZXJ2cC1tYW5hZ2VyLnZicyIsICJieXRlcyI6IDQxNiwgImFjdGl2ZSI6IHRydWV9XSwgImdhdGV3YXlzIjogW10sICJnYXRld2F5X2NoaWxkcmVuIjogW10sICJsZWRnZXIiOiB7ImV4aXN0cyI6IHRydWUsICJ1bmZpbmlzaGVkX2FsbF9wcm9maWxlIjogMCwgImFjdGl2ZV9tZXRhZGF0YSI6IFtdfSwgInJ1bnRpbWVfc3RhdHVzIjogeyJ1cGRhdGVkX2F0IjogIjIwMjYtMTAtMjFUMTE6MTI6MDUuODk4Mjk0KzAwOjAwIiwgInBpZCI6IDExNTkyLCAiYWN0aXZlX2FnZW50cyI6IDAsICJzdGFydF90aW1lIjogMTc5MjU4MTAxOTY0fSwgImhlYXJ0YmVhdF9tb2RpZmllZCI6ICIyMDI2LTEwLTIxVDE5OjQ5OjU1LjEyNTgwODJaIiwgImRlZmF1bHRfYWxpYXNfY2F1dGlvbiI6IGZhbHNlfQ=='
$CustodyConfirmed=$false
$ErrorActionPreference='Stop'
$cfg=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64))|ConvertFrom-Json
$name=[string]$cfg.profile
if($name -notin @('cs-mallory','cs-jasmine','cs-rae','cs-ali','cs-joe','cust-service','nick','hermesops-2','accounting-sharon','tripower-consulting','ervp-manager','ervp-orders','hermesops','accounting-migration')){throw 'Profile not approved for this idle stop procedure'}
if($name -in @('accounting-sharon','tripower-consulting') -and -not $CustodyConfirmed){throw 'Custody metadata must be captured before this profile stop'}
$base=Join-Path 'C:\Users\nicho\AppData\Local\hermes\profiles' $name
if($cfg.home -ne $base){throw 'Profile home mismatch'}
$pattern='(?:--profile|-p)\s+'+[regex]::Escape($name)+'(?:\s|$)'
$dir=Join-Path 'C:\Users\nicho\backups\hermes-phase2b-20261021\step05' $name
New-Item -ItemType Directory -Path $dir -Force|Out-Null
$journal=Join-Path $dir 'idle-steps.jsonl'
if(Test-Path $journal){throw 'Idle stop journal exists; reconcile source instead of repeating'}
function Record-Step($x){$x|ConvertTo-Json -Depth 10 -Compress|Add-Content $journal -Encoding UTF8}
$all=@(Get-CimInstance Win32_Process)
$live=@($all|Where-Object {$_.CommandLine -match $pattern -and $_.CommandLine -match 'gateway\s+run'})
$expected=@($cfg.gateways)
$ids=@($expected|ForEach-Object {$_.pid})
if($live.Count -ne $expected.Count){throw 'Gateway count changed; inspect before stop'}
foreach($e in $expected){$p=@($live|Where-Object {$_.ProcessId -eq $e.pid -and $_.ParentProcessId -eq $e.parent -and $_.CreationDate.ToString('o') -eq $e.created});if($p.Count -ne 1){throw 'Gateway identity changed'}}
$children=@($all|Where-Object {$_.ParentProcessId -in $ids})
$workers=@($children|Where-Object {$_.ProcessId -notin $ids -and $_.Name -ne 'conhost.exe'})
if($workers.Count){throw 'Additional child work present; no stop'}
$statusPath=Join-Path $base 'gateway_state.json'
if($live.Count){
 if(-not(Test-Path $statusPath)){throw 'No runtime active-agent metadata'}
 $status=Get-Content $statusPath -Raw|ConvertFrom-Json
 if($status.pid -notin $ids -or $status.active_agents -ne 0){throw 'Runtime status indicates work or mismatched process'}
 $heartbeat=Join-Path $base 'state\gateway.heartbeat'
 if(-not(Test-Path $heartbeat) -or ((Get-Date).ToUniversalTime()-(Get-Item $heartbeat).LastWriteTimeUtc).TotalSeconds -gt 120){throw 'Gateway heartbeat stale; inspect before stop'}
}
$cron=Join-Path $base 'cron\jobs.json'
if(Test-Path $cron){$d=Get-Content $cron -Raw|ConvertFrom-Json;$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)};if(@($jobs|Where-Object {$_.enabled}).Count){throw 'Enabled profile cron remains'}}
$py=@'
import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1])/'cron'/'executions.db';n=0
if p.exists():
 c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);n=c.execute("select count(*) from executions where finished_at is null and status not in ('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')").fetchone()[0];c.close()
if n:raise SystemExit('Unfinished profile execution')
print(n)
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$count=& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$encoded'))" $base
if($LASTEXITCODE -ne 0 -or [string]$count -ne '0'){throw 'No-in-flight ledger check failed'}
$taskNames=@($cfg.tasks|Where-Object {$_.enabled}|ForEach-Object {$_.name})
$references=@(Get-ScheduledTask|Where-Object {$_.Settings.Enabled -and @($_.Actions|Where-Object {($_.Arguments -match [regex]::Escape($name) -or $_.Execute -match [regex]::Escape($name))}).Count -gt 0})
if($references.Count -ne $taskNames.Count -or @($references|Where-Object {$_.TaskName -notin $taskNames}).Count){throw 'Task dependencies changed'}
foreach($t in $references){if($t.TaskName -notmatch 'Watchdog|^Hermes_Gateway_' -or [string]$t.State -ne 'Ready'){throw 'Non-idle task dependency or launcher in flight'}}
$launchers=@($cfg.startup|Where-Object {$_.active})
foreach($l in $launchers){if(Test-Path ($l.path+'.disabled-20261021')){throw 'Disabled launcher exists; inspect prior effects'};if((Get-FileHash $l.path).Hash -ne $l.sha256){throw 'Launcher identity changed'}}
$taskReceipts=@()
foreach($t in @($references|Sort-Object @{Expression={if($_.TaskName -match 'Watchdog'){0}else{1}}})){
 $i=$t|Get-ScheduledTaskInfo
 Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath|Out-Null
 $read=Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
 if($read.Settings.Enabled){throw 'Watchdog disable readback failed'}
 $r=@{name=$t.TaskName;at=(Get-Date -Format o);enabled=$false;last_run=$i.LastRunTime.ToString('o');last_result=$i.LastTaskResult};$taskReceipts+=$r;Record-Step (@{step='disable_profile_watchdog';receipt=$r})
}
$ensure=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -match [regex]::Escape($base) -and $_.CommandLine -match 'ensure.*gateway|gateway_watchdog'})
if($ensure.Count){throw 'Watchdog helper still in flight; allow drain and reconcile journal'}
$launcherReceipts=@()
foreach($l in $launchers){
 $dest=$l.path+'.disabled-20261021'
 Rename-Item -LiteralPath $l.path -NewName ($l.name+'.disabled-20261021')
 if((Test-Path $l.path) -or (Get-FileHash $dest).Hash -ne $l.sha256){throw 'Launcher rename readback failed'}
 $r=@{old=$l.path;new=$dest;sha256=$l.sha256;at=(Get-Date -Format o)};$launcherReceipts+=$r;Record-Step (@{step='rename_active_startup';receipt=$r})
}
$stops=@()
foreach($e in @($expected|Sort-Object @{Expression={if($_.parent -in $ids){1}else{0}}})){
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($e.pid)"
 if($p -and $p.CreationDate -and $p.CreationDate.ToString('o') -eq $e.created -and $p.ParentProcessId -eq $e.parent -and $p.CommandLine -match $pattern -and $p.CommandLine -match 'gateway\s+run'){
  Stop-Process -Id $e.pid
  $r=@{pid=$e.pid;parent=$e.parent;created=$e.created;at=(Get-Date -Format o);effect='exact gateway PID stopped'}
 }else{$r=@{pid=$e.pid;at=(Get-Date -Format o);effect='not stopped: already exited or identity no longer matches; final profile scan required'}}
 $stops+=$r;Record-Step (@{step='gateway_process';receipt=$r})
}
$remaining=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -match $pattern -and $_.CommandLine -match 'gateway\s+run'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}})
$when=Get-Date -Format o
$result=[pscustomobject]@{item=5;profile=$name;at=$when;observation_start=$when;remaining_gateways=$remaining;tasks=$taskReceipts;launchers=$launcherReceipts;process_stops=$stops;no_inflight=@{unfinished_all_profile=0;additional_child_workers=0;active_agents=if($live.Count){$status.active_agents}else{0};runtime_status_updated_at=if($live.Count){$status.updated_at}else{$null}};journal=$journal;observation='Pending 15 minutes';original_files_preserved=$true}
$result|ConvertTo-Json -Depth 10|Set-Content (Join-Path $dir 'idle-stop-receipt.json') -Encoding UTF8
$result|ConvertTo-Json -Depth 10
