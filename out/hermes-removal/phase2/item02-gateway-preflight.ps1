$ErrorActionPreference='Stop'
$b='C:\Users\nicho\AppData\Local\hermes\profiles\cs-tim'
$procs=@(Get-CimInstance Win32_Process)
$gateways=@($procs|Where-Object {$_.CommandLine -match '(?:--profile|-p)\s+cs-tim(?:\s|$)' -and $_.CommandLine -match 'gateway\s+run'})
$procmeta=@($gateways|ForEach-Object {$p=$_;@{pid=$p.ProcessId;parent=$p.ParentProcessId;name=$p.Name;executable=$p.ExecutablePath;created=$p.CreationDate.ToString('o');children=@($procs|Where-Object {$_.ParentProcessId -eq $p.ProcessId}|ForEach-Object {@{pid=$_.ProcessId;name=$_.Name;created=$_.CreationDate.ToString('o')}})}})
$tasks=@(Get-ScheduledTask|Where-Object {$_.Settings.Enabled -and (@($_.Actions|Where-Object {$_.Arguments -match 'cs-tim'}).Count -gt 0)}|ForEach-Object {@{name=$_.TaskName;state=[string]$_.State}})
$doc=Get-Content "$b\cron\jobs.json" -Raw|ConvertFrom-Json
$jobs=if($null -ne $doc.jobs){@($doc.jobs)}else{@($doc)}
$enabled=@($jobs|Where-Object {$_.enabled}|ForEach-Object {$_.id})
$status=Get-Content "$b\gateway_state.json" -Raw|ConvertFrom-Json
$heartbeat=Get-Content "$b\state\gateway.heartbeat" -Raw|ConvertFrom-Json
$py=@'
import pathlib,sqlite3,json
p=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\cs-tim\cron\executions.db')
c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
rows=c.execute("select job_id,status,pid,claimed_at,started_at from executions where finished_at is null and status not in ('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')").fetchall()
print(json.dumps({'unfinished_all_profile':len(rows),'active_metadata':[dict(zip(['job_id','status','pid','claimed_at','started_at'],r)) for r in rows]}));c.close()
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$ledger=(& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))")|ConvertFrom-Json
if($LASTEXITCODE -ne 0){throw 'Ledger preflight failed'}
[pscustomobject]@{at=(Get-Date -Format o);profile='cs-tim';processes=$procmeta;enabled_cron_ids=$enabled;referencing_enabled_tasks=$tasks;runtime_status=@{pid=$status.pid;active_agents=$status.active_agents;updated_at=$status.updated_at;start_time=$status.start_time};heartbeat_keys=@($heartbeat.PSObject.Properties.Name);heartbeat_file_modified=(Get-Item "$b\state\gateway.heartbeat").LastWriteTimeUtc.ToString('o');ledger=$ledger;launcher=@{path="$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Hermes_Gateway_cs-tim.vbs";sha256=(Get-FileHash "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Hermes_Gateway_cs-tim.vbs").Hash}}|ConvertTo-Json -Depth 8
