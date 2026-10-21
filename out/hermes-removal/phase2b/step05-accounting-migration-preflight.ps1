$ProfileName='accounting-migration'
$ErrorActionPreference='Stop'
$allowed=@('cs-mallory','cs-jasmine','cs-rae','cs-ali','cs-joe','cust-service','nick','hermesops-2','accounting-sharon','tripower-consulting','default','ervp-manager','ervp-orders','hermesops','accounting-migration')
if($ProfileName -notin $allowed){throw 'Profile outside approved idle list'}
$base=Join-Path 'C:\Users\nicho\AppData\Local\hermes\profiles' $ProfileName
$pattern='(?:--profile|-p)\s+'+[regex]::Escape($ProfileName)+'(?:\s|$)'
$all=@(Get-CimInstance Win32_Process)
$gateways=@($all|Where-Object {$_.CommandLine -match $pattern -and $_.CommandLine -match 'gateway\s+run'})
$pids=@($gateways|ForEach-Object {$_.ProcessId})
$processes=@($gateways|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o');name=$_.Name;executable=$_.ExecutablePath}})
$children=@($all|Where-Object {$_.ParentProcessId -in $pids}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name;created=$_.CreationDate.ToString('o');matches_profile_gateway=($_.CommandLine -match $pattern -and $_.CommandLine -match 'gateway\s+run')}})
$enabled=@()
$cron=Join-Path $base 'cron\jobs.json'
if(Test-Path $cron){$d=Get-Content $cron -Raw|ConvertFrom-Json;$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)};$enabled=@($jobs|Where-Object {$_.enabled}|ForEach-Object {$_.id})}
$tasks=@(Get-ScheduledTask|Where-Object {@($_.Actions|Where-Object {($_.Arguments -match [regex]::Escape($ProfileName) -or $_.Execute -match [regex]::Escape($ProfileName))}).Count -gt 0}|ForEach-Object {$t=$_;$i=$t|Get-ScheduledTaskInfo;@{name=$t.TaskName;enabled=$t.Settings.Enabled;state=[string]$t.State;last_run=$i.LastRunTime.ToString('o');last_result=$i.LastTaskResult;next_run=if($i.NextRunTime){$i.NextRunTime.ToString('o')}else{$null}}})
$startup=@(Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" -File|Where-Object {$_.Name -match [regex]::Escape($ProfileName)}|ForEach-Object {@{name=$_.Name;path=$_.FullName;active=($_.Extension -in '.vbs','.cmd','.bat','.lnk','.exe');bytes=$_.Length;sha256=(Get-FileHash $_.FullName).Hash}})
$statusPath=Join-Path $base 'gateway_state.json'
$status=if(Test-Path $statusPath){Get-Content $statusPath -Raw|ConvertFrom-Json}else{$null}
$heartbeat=Join-Path $base 'state\gateway.heartbeat'
$py=@'
import pathlib,sqlite3,json,sys
p=pathlib.Path(sys.argv[1])/'cron'/'executions.db';o={'exists':p.exists(),'unfinished_all_profile':0,'active_metadata':[]}
if p.exists():
 c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=5)
 rows=c.execute("select job_id,status,pid,claimed_at,started_at from executions where finished_at is null and status not in ('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')").fetchall();o.update(unfinished_all_profile=len(rows),active_metadata=[dict(zip(['job_id','status','pid','claimed_at','started_at'],v)) for v in rows]);c.close()
print(json.dumps(o))
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$ledger=(& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$encoded'))" $base)|ConvertFrom-Json
if($LASTEXITCODE -ne 0){throw 'Idle profile ledger read failed'}
[pscustomobject]@{at=(Get-Date -Format o);profile=$ProfileName;home=$base;home_exists=(Test-Path $base);enabled_cron_ids=$enabled;tasks=$tasks;startup=$startup;gateways=$processes;gateway_children=$children;ledger=$ledger;runtime_status=if($status){@{pid=$status.pid;active_agents=$status.active_agents;updated_at=$status.updated_at;start_time=$status.start_time}}else{$null};heartbeat_modified=if(Test-Path $heartbeat){(Get-Item $heartbeat).LastWriteTimeUtc.ToString('o')}else{$null};default_alias_caution=($ProfileName -eq 'default','ervp-manager','ervp-orders','hermesops','accounting-migration')}|ConvertTo-Json -Depth 10
