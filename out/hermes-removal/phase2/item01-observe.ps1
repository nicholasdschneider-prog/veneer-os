$ErrorActionPreference='Stop'
$t=Get-ScheduledTask -TaskName 'OrderOps_Order_Completion_Mirror'
$i=$t|Get-ScheduledTaskInfo
$proc=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -match 'OrderOps_Order_Completion_Mirror|sync_order_completion_board|run_order_completion_sync'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o');name=$_.Name}})
$py=@'
import pathlib,json,re,hashlib
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-orders');p=r/'scripts'/'sync_order_completion_board.cjs'
s=p.read_text(encoding='utf8',errors='replace')
# Return only path-like source literals and metadata for completion state artifacts.
o={'path_literals':list(set(re.findall(r'[\w./\\-]*(?:completion|checkpoint|ledger)[\w./\\-]*\.(?:json|db|sqlite|jsonl)',s,re.I))),'state_files':[]}
for d in [r/'state',r/'scripts',r/'data']:
 if d.exists():
  for f in d.iterdir():
   if f.is_file() and re.search('completion|ledger|checkpoint',f.name,re.I) and not re.search('secret|token|credential|auth|\.env',f.name,re.I):
    st=f.stat();o['state_files'].append({'path':str(f),'bytes':st.st_size,'mtime_ns':st.st_mtime_ns,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$state=(& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))")|ConvertFrom-Json
$archive='C:\Users\nicho\backups\hermes-final-20261016'
$archiveState=if(Test-Path "$archive\status.json"){Get-Content "$archive\status.json" -Raw|ConvertFrom-Json}else{$null}
$observed=Get-Date
if($observed -lt [datetimeoffset]::Parse('2026-10-16T08:44:15.5501125-04:00').LocalDateTime){throw 'Observation window not complete'}
[pscustomobject]@{item=1;observed_at=(Get-Date -Format o);enabled=$t.Settings.Enabled;task_state=[string]$t.State;last_run=$i.LastRunTime.ToString('o');last_result=$i.LastTaskResult;matching_processes=$proc;state_metadata=$state;archive_status=$archiveState}|ConvertTo-Json -Depth 10
