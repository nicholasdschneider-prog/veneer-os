$ErrorActionPreference='Stop'
$b='C:\Users\nicho\AppData\Local\hermes\profiles\cs-tim'
$journal='C:\Users\nicho\backups\hermes-phase2-20261016\cs-tim\gateway-steps.jsonl'
function Record-Step($data){$data|ConvertTo-Json -Compress -Depth 8|Add-Content -LiteralPath $journal -Encoding UTF8}
$all=@(Get-CimInstance Win32_Process)
$p=@($all|Where-Object {$_.CommandLine -match '(?:--profile|-p)\s+cs-tim(?:\s|$)' -and $_.CommandLine -match 'gateway\s+run'})
if($p.Count -ne 1 -or $p[0].ProcessId -ne 10056 -or $p[0].ParentProcessId -ne 4856 -or $p[0].CreationDate.ToString('o') -ne '2026-10-15T14:18:52.0552880-04:00'){throw 'Gateway identity changed; no stop'}
if(@($all|Where-Object {$_.ParentProcessId -eq 10056}).Count -gt 0){throw 'Gateway has children; inspect before stop'}
$doc=Get-Content "$b\cron\jobs.json" -Raw|ConvertFrom-Json
$jobs=if($null -ne $doc.jobs){@($doc.jobs)}else{@($doc)}
if(@($jobs|Where-Object {$_.enabled}).Count -gt 0){throw 'Enabled Tim cron remains'}
$s=Get-Content "$b\gateway_state.json" -Raw|ConvertFrom-Json
if($s.pid -ne 10056 -or $s.active_agents -ne 0){throw 'Runtime status shows work or wrong PID'}
$py=@'
import sqlite3,pathlib
p=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\cs-tim\cron\executions.db')
c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
n=c.execute("select count(*) from executions where finished_at is null and status not in ('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')").fetchone()[0]
c.close()
if n:raise SystemExit('Unfinished profile executions; do not stop')
print(n)
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$count=& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0 -or [string]$count -ne '0'){throw 'No-in-flight check failed'}
$launcher="$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Hermes_Gateway_cs-tim.vbs"
$renamed=$launcher+'.disabled-20261016'
if(Test-Path -LiteralPath $renamed){throw 'Disabled launcher already exists; inspect prior effects'}
$hash=(Get-FileHash -LiteralPath $launcher).Hash
if($hash -ne '41A00EE6C553B611D9EAD5A093A54B54EF6FEC14B9AC2EB581C096EA9E85CAD4'){throw 'Launcher identity changed'}
$t=Get-ScheduledTask -TaskName 'Hermes_CS_Tim_Watchdog'
$i=$t|Get-ScheduledTaskInfo
if(-not $t.Settings.Enabled -or [string]$t.State -ne 'Ready'){throw 'Watchdog changed or in flight; inspect'}
Disable-ScheduledTask -TaskName 'Hermes_CS_Tim_Watchdog'|Out-Null
$when=Get-Date -Format o
$t=Get-ScheduledTask -TaskName 'Hermes_CS_Tim_Watchdog'
if($t.Settings.Enabled){throw 'Watchdog disable failed'}
Record-Step @{step='disable_watchdog';at=$when;task=$t.TaskName;enabled=$t.Settings.Enabled;last_run=$i.LastRunTime.ToString('o');last_result=$i.LastTaskResult}
Rename-Item -LiteralPath $launcher -NewName 'Hermes_Gateway_cs-tim.vbs.disabled-20261016'
if((Test-Path -LiteralPath $launcher) -or (Get-FileHash -LiteralPath $renamed).Hash -ne $hash){throw 'Launcher rename readback failed'}
Record-Step @{step='rename_launcher';at=(Get-Date -Format o);old=$launcher;new=$renamed;sha256=$hash}
$fresh=Get-CimInstance Win32_Process -Filter 'ProcessId=10056'
if(-not $fresh -or $fresh.CreationDate -ne $p[0].CreationDate -or $fresh.CommandLine -notmatch '(?:--profile|-p)\s+cs-tim(?:\s|$)'){throw 'PID identity changed; no stop'}
Stop-Process -Id 10056
$stop=Get-Date -Format o
Record-Step @{step='stop_exact_gateway';at=$stop;pid=10056;parent=4856;created=$p[0].CreationDate.ToString('o');unfinished_executions=0;active_agents=0;child_processes=0;method='Stop-Process -Id 10056; no broad tree or force command';runtime_status_updated_at=$s.updated_at}
$remaining=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -match '(?:--profile|-p)\s+cs-tim(?:\s|$)' -and $_.CommandLine -match 'gateway\s+run'}|ForEach-Object {@{pid=$_.ProcessId;created=$_.CreationDate.ToString('o')}})
[pscustomobject]@{item=2;profile='cs-tim';watchdog_disabled_at=$when;stopped_at=$stop;watchdog_enabled=$t.Settings.Enabled;launcher=$renamed;remaining_gateways=$remaining;no_inflight=@{all_profile_unfinished=0;active_agents=0;child_processes=0;runtime_status_updated_at=$s.updated_at};journal_path=$journal;steps=@(Get-Content -LiteralPath $journal|ForEach-Object {$_|ConvertFrom-Json});observation='Pending full 15 minutes after gateway stop'}|ConvertTo-Json -Depth 9
