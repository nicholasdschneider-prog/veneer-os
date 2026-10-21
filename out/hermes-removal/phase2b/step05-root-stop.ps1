$ErrorActionPreference='Stop'
$dir='C:\Users\nicho\backups\hermes-phase2b-20261021\step05\default';$j=Join-Path $dir 'gateway-stop.json'
if(Test-Path $j){throw 'Existing mutation journal; inspect source, no repeat'}
$base='C:\Users\nicho\AppData\Local\hermes';$runtimeBase=$base+'\profiles\ervp-manager';$pattern='gateway\s+run';$profilePattern='(?:--profile|-p)\s+[\w-]+'
$all=@(Get-CimInstance Win32_Process);$live=@($all|Where-Object{$_.CommandLine -match $pattern -and $_.CommandLine -notmatch $profilePattern})
if($live.Count -ne 1 -or $live[0].ProcessId -ne 11592 -or $live[0].ParentProcessId -ne 7940 -or $live[0].CreationDate.ToString('o') -ne '2026-10-21T07:10:19.6363930-04:00'){throw 'Gateway identity changed; no mutation'}
if(@($all|Where-Object{$_.ParentProcessId -eq 11592 -and $_.Name -ne 'conhost.exe'}).Count){throw 'Child work present'}
$status=Get-Content "$runtimeBase\gateway_state.json" -Raw|ConvertFrom-Json
if($status.pid -ne 11592 -or $status.active_agents -ne 0 -or ((Get-Date).ToUniversalTime()-(Get-Item "$runtimeBase\state\gateway.heartbeat").LastWriteTimeUtc).TotalSeconds -gt 120){throw 'Runtime work or heartbeat mismatch'}
$d=Get-Content "$base\cron\jobs.json" -Raw|ConvertFrom-Json;$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)}
if(@($jobs|Where-Object{$_.enabled}).Count){throw 'Enabled jobs remain'}
$count=& 'C:\Python314\python.exe' -c "import sqlite3; c=sqlite3.connect('file:C:/Users/nicho/AppData/Local/hermes/cron/executions.db?mode=ro',uri=True); print(c.execute('select count(*) from executions where finished_at is null and status not in (?,?,?,?,?,?,?)',('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')).fetchone()[0]); c.close()"
if($LASTEXITCODE -ne 0 -or [string]$count -ne '0'){throw 'Unfinished executions or unreadable ledger'}
$managerCount=& 'C:\Python314\python.exe' -c "import sqlite3; c=sqlite3.connect('file:C:/Users/nicho/AppData/Local/hermes/profiles/ervp-manager/cron/executions.db?mode=ro',uri=True); print(c.execute('select count(*) from executions where finished_at is null and status not in (?,?,?,?,?,?,?)',('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')).fetchone()[0]); c.close()"
if($LASTEXITCODE -ne 0 -or [string]$managerCount -ne '0'){throw 'Manager unfinished work; no stop'}
$t=Get-ScheduledTask -TaskName 'Hermes_Gateway';$i=$t|Get-ScheduledTaskInfo
if(-not $t.Settings.Enabled -or [string]$t.State -ne 'Ready' -or $t.Actions[0].Arguments -notmatch 'Hermes_Gateway\.vbs'){throw 'Task changed/inflight'}
[IO.Directory]::CreateDirectory($dir)|Out-Null
[IO.File]::WriteAllText((Join-Path $dir 'watchdog-before.xml'),(Export-ScheduledTask -TaskName $t.TaskName),(New-Object Text.UTF8Encoding($false)))
$r=@{profile='default';started_at=(Get-Date).ToUniversalTime().ToString('o');last_run=$i.LastRunTime.ToString('o');watchdog=$t.TaskName;xml_sha256=(Get-FileHash (Join-Path $dir 'watchdog-before.xml')).Hash;no_inflight=@{active_agents=0;unfinished_all_profile=0;child_workers=0};expected_pid=11592;parent=7940;created=$live[0].CreationDate.ToString('o')}
$r|ConvertTo-Json -Depth 8|Set-Content $j -Encoding UTF8
Disable-ScheduledTask -TaskName $t.TaskName|Out-Null
$r.watchdog_disabled_at=(Get-Date).ToUniversalTime().ToString('o');$r.task_enabled=(Get-ScheduledTask -TaskName $t.TaskName).Settings.Enabled
$r|ConvertTo-Json -Depth 8|Set-Content $j -Encoding UTF8
if($r.task_enabled){throw 'Watchdog disable failed'}
$r.launchers=@();$r.historical_startup_preserved=$true
$p=Get-CimInstance Win32_Process -Filter 'ProcessId=11592'
if(-not $p -or $p.ParentProcessId -ne 7940 -or $p.CreationDate.ToString('o') -ne $r.created -or ($p.CommandLine -notmatch $pattern -or $p.CommandLine -match $profilePattern)){throw 'PID changed before stop; inspect partial journal'}
Stop-Process -Id 11592
$r.stopped_at=(Get-Date).ToUniversalTime().ToString('o');$r.observation_start=$r.stopped_at
$r|ConvertTo-Json -Depth 8|Set-Content $j -Encoding UTF8
$r|ConvertTo-Json -Depth 8
