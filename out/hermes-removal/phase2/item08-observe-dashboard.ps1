$ErrorActionPreference='Stop'
$start=[datetimeoffset]::Parse('2026-10-16T12:19:11.2141979-04:00')
$now=[datetimeoffset]::Now
$t=Get-ScheduledTask -TaskName 'ERVP Hermes Dashboard'
$i=$t|Get-ScheduledTaskInfo
$all=@(Get-CimInstance Win32_Process)
$procs=@($all|Where-Object {$_.CommandLine -match 'hermes' -and $_.CommandLine -match 'dashboard'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}})
$old='C:\Users\nicho\AppData\Local\hermes\services\dashboard\dashboard_supervisor.vbs'
$new=$old+'.disabled-20261016'
$hash=if(Test-Path $new){(Get-FileHash $new).Hash}else{$null}
$checks=@{full_15m=(($now-$start).TotalSeconds -ge 900);task_disabled=(-not $t.Settings.Enabled);task_last_run_unchanged=($i.LastRunTime.ToString('o') -eq '2026-10-15T14:18:50.0000000-04:00');no_dashboard_processes=($procs.Count -eq 0);active_task_launcher_absent=(-not(Test-Path $old));disabled_launcher_hash_unchanged=($hash -eq 'A18DDAA136FDE639E1AC306FC298A0804CF295EF6CEEC055A5ACE5B9ED2435AB')}
[pscustomobject]@{at=$now.ToString('o');item=8;observation_start=$start.ToString('o');elapsed_seconds=($now-$start).TotalSeconds;checks=$checks;dashboard_processes=$procs;launcher=$new;launcher_sha256=$hash}|ConvertTo-Json -Depth 7
