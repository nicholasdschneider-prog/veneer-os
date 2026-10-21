$ErrorActionPreference='Stop'
$t=Get-ScheduledTask -TaskName 'Hermes_Brain_Backup';$i=Get-ScheduledTaskInfo -InputObject $t
$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect()
$instances=@($svc.GetRunningTasks(1)|Where-Object{$_.Name -eq 'Hermes_Brain_Backup'}|ForEach-Object{@{guid=$_.InstanceGuid;pid=$_.EnginePID}})
$all=@(Get-CimInstance Win32_Process);$ids=@($all|Where-Object{[string]$_.CommandLine -match 'Hermes_Brain_Backup-silent\.vbs|Sync-HermesBrain\.ps1'}|ForEach-Object{[uint32]$_.ProcessId})
do{$n=$ids.Count;$ids=@($ids+@($all|Where-Object{$ids -contains [uint32]$_.ParentProcessId}|ForEach-Object{[uint32]$_.ProcessId})|Select-Object -Unique)}while($ids.Count -gt $n)
$processes=@($all|Where-Object{$ids -contains [uint32]$_.ProcessId}|ForEach-Object{@{pid=$_.ProcessId;parent_pid=$_.ParentProcessId;created=$_.CreationDate.ToString('o');name=$_.Name;executable=$_.ExecutablePath}})
@{at=(Get-Date).ToUniversalTime().ToString('o');task=@{name=$t.TaskName;enabled=$t.Settings.Enabled;state=[string]$t.State;last_run=$i.LastRunTime.ToString('o');last_result=$i.LastTaskResult;next_run=$i.NextRunTime.ToString('o');intervals=@($t.Triggers|ForEach-Object{$_.Repetition.Interval});action_paths=@($t.Actions|ForEach-Object{[regex]::Matches($_.Arguments,'[A-Za-z]:\\[^"\r\n]*?\.vbs')|ForEach-Object{$_.Value}})};running_instances=$instances;processes=$processes;no_inflight=($instances.Count -eq 0 -and $processes.Count -eq 0)}|ConvertTo-Json -Depth 8
