$ErrorActionPreference='Stop'
if([datetimeoffset]::UtcNow -lt [datetimeoffset]::Parse('2026-10-16T16:18:28.514385Z')){throw 'Full cron observation window not complete'}
$dir='C:\Users\nicho\AppData\Local\hermes\services\dashboard'
$journalDir='C:\Users\nicho\backups\hermes-phase2-20261016\dashboard'
New-Item -ItemType Directory -Path $journalDir -Force|Out-Null
$journal=Join-Path $journalDir 'steps.jsonl'
if(Test-Path -LiteralPath $journal){throw 'Dashboard stop journal exists; inspect prior effects before any retry'}
function Record-Step($d){$d|ConvertTo-Json -Compress -Depth 8|Add-Content -LiteralPath $journal -Encoding UTF8}
$expected=@(
 @{pid=9500;parent=5096;created='2026-10-15T14:18:51.6955790-04:00';role='supervisor'},
 @{pid=10500;parent=9500;created='2026-10-15T14:19:02.1558450-04:00';role='dashboard wrapper'},
 @{pid=5372;parent=10500;created='2026-10-15T14:19:02.1842520-04:00';role='dashboard server'}
)
$all=@(Get-CimInstance Win32_Process)
foreach($e in $expected){
 $p=@($all|Where-Object {$_.ProcessId -eq $e.pid})
 if($p.Count -ne 1 -or $p[0].ParentProcessId -ne $e.parent -or $p[0].CreationDate.ToString('o') -ne $e.created -or $p[0].CommandLine -notmatch 'dashboard'){throw 'Dashboard process identity changed; no stop'}
}
$unknown=@($all|Where-Object {$_.ParentProcessId -in 9500,10500,5372 -and $_.ProcessId -notin 10500,5372,10496})
if($unknown.Count){throw 'Additional dashboard child work exists; inspect before stop'}
$conhost=@($all|Where-Object {$_.ProcessId -eq 10496})
if($conhost.Count -and ($conhost[0].Name -ne 'conhost.exe' -or $conhost[0].ParentProcessId -ne 10500)){throw 'Console child identity changed'}
$held=@($all|Where-Object {$_.CommandLine -match '(?:--profile|-p)\s+(ervp-manager|ervp-orders|hermesops)(?:\s|$)' -and $_.CommandLine -match 'gateway\s+run'}|ForEach-Object {@{pid=$_.ProcessId;created=$_.CreationDate.ToString('o')}})
if(@($held|Where-Object {$_.pid -in 9500,10500,5372}).Count){throw 'Held gateway overlaps dashboard identities'}
$doc=Get-Content 'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-manager\cron\jobs.json' -Raw|ConvertFrom-Json
$jobs=if($null -ne $doc.jobs){@($doc.jobs)}else{@($doc)}
foreach($id in @('89de9427e76b','917a1ee90aec')){if(@($jobs|Where-Object {$_.id -eq $id -and $_.enabled -eq $false}).Count -ne 1){throw 'Dashboard infrastructure cron not disabled'}}
$py=@'
import pathlib,sqlite3
p=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-manager\cron\executions.db');c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
n=c.execute("select count(*) from executions where job_id in ('89de9427e76b','917a1ee90aec') and finished_at is null and status not in ('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')").fetchone()[0];c.close()
if n:raise SystemExit('Infrastructure execution still unfinished')
print(n)
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$count=& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$encoded'))"
if($LASTEXITCODE -ne 0 -or [string]$count -ne '0'){throw 'No-in-flight infrastructure check failed'}
$t=Get-ScheduledTask -TaskName 'ERVP Hermes Dashboard'
$i=$t|Get-ScheduledTaskInfo
if(-not $t.Settings.Enabled -or [string]$t.State -ne 'Ready'){throw 'Dashboard task changed or running launcher; inspect'}
$launcher=Join-Path $dir 'dashboard_supervisor.vbs'
$renamed=$launcher+'.disabled-20261016'
if(Test-Path -LiteralPath $renamed){throw 'Disabled launcher exists; inspect prior effects'}
$hash=(Get-FileHash -LiteralPath $launcher).Hash
if($hash -ne 'A18DDAA136FDE639E1AC306FC298A0804CF295EF6CEEC055A5ACE5B9ED2435AB'){throw 'Task launcher identity changed'}
Disable-ScheduledTask -TaskName 'ERVP Hermes Dashboard'|Out-Null
$t=Get-ScheduledTask -TaskName 'ERVP Hermes Dashboard'
if($t.Settings.Enabled){throw 'Dashboard task disable readback failed'}
Record-Step @{step='disable_dashboard_task';at=(Get-Date -Format o);name=$t.TaskName;enabled=$t.Settings.Enabled;last_run=$i.LastRunTime.ToString('o');last_result=$i.LastTaskResult}
Rename-Item -LiteralPath $launcher -NewName 'dashboard_supervisor.vbs.disabled-20261016'
if((Test-Path -LiteralPath $launcher) -or (Get-FileHash -LiteralPath $renamed).Hash -ne $hash){throw 'Task launcher rename readback failed'}
Record-Step @{step='rename_task_launcher';at=(Get-Date -Format o);old=$launcher;new=$renamed;sha256=$hash;startup_note='No active dashboard Startup launcher; historical disabled CMD retained as Tier C'}
foreach($e in $expected){
 $fresh=Get-CimInstance Win32_Process -Filter "ProcessId=$($e.pid)"
 if($fresh){
  if($fresh.CreationDate.ToString('o') -ne $e.created -or $fresh.ParentProcessId -ne $e.parent -or $fresh.CommandLine -notmatch 'dashboard'){throw 'PID identity changed; no further stop'}
  Stop-Process -Id $e.pid
  Record-Step @{step='stop_exact_process';at=(Get-Date -Format o);pid=$e.pid;parent=$e.parent;created=$e.created;role=$e.role;method='Stop-Process exact PID; no force or broad process tree command'}
 }else{Record-Step @{step='already_exited_after_parent_stop';at=(Get-Date -Format o);pid=$e.pid;role=$e.role}}
}
$stopped=Get-Date -Format o
$after=@(Get-CimInstance Win32_Process)
$remaining=@($after|Where-Object {$_.CommandLine -match 'hermes' -and $_.CommandLine -match 'dashboard'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}})
$heldCheck=@($held|ForEach-Object {$h=$_;$live=@($after|Where-Object {$_.ProcessId -eq $h.pid -and $_.CreationDate.ToString('o') -eq $h.created});@{pid=$h.pid;created=$h.created;unchanged=($live.Count -eq 1)}})
[pscustomobject]@{item=8;stopped_at=$stopped;task_enabled=$t.Settings.Enabled;task_last_run=$i.LastRunTime.ToString('o');renamed_launcher=$renamed;launcher_sha256=$hash;no_inflight=@{infrastructure_unfinished=0;additional_dashboard_workers=0;expected_console_only=$true};remaining_dashboard_processes=$remaining;held_gateway_identity_check=$heldCheck;journal_path=$journal;steps=@(Get-Content $journal|ForEach-Object {$_|ConvertFrom-Json});observation='Pending 15 minutes after final stop'}|ConvertTo-Json -Depth 10
