$ErrorActionPreference='Stop'
$n='OrderOps_Order_Completion_Mirror'
$t=Get-ScheduledTask -TaskName $n
$i=$t|Get-ScheduledTaskInfo
$before=@{enabled=$t.Settings.Enabled;state=[string]$t.State;last_run=$i.LastRunTime.ToString('o');next_run=$i.NextRunTime.ToString('o');result=$i.LastTaskResult}
$proc=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -match 'OrderOps_Order_Completion_Mirror|completion.mirror'} | ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name;created=$_.CreationDate.ToString('o')}})
Disable-ScheduledTask -TaskName $n | Out-Null
$when=Get-Date -Format o
$t=Get-ScheduledTask -TaskName $n
if($t.Settings.Enabled){throw 'Disable readback failed'}
$files=@(Get-ChildItem 'C:\Users\nicho\AppData\Local\hermes\services' -File | Where-Object {$_.Name -match 'completion|mirror'} | ForEach-Object {@{path=$_.FullName;size=$_.Length;modified=$_.LastWriteTimeUtc.ToString('o');sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash}})
[pscustomobject]@{item=1;task=$n;disabled_at=$when;before=$before;after_enabled=$t.Settings.Enabled;after_state=[string]$t.State;inflight_processes=$proc;files=$files;observation='Pending: full five-minute cycle after disable and drain'}|ConvertTo-Json -Depth 8
