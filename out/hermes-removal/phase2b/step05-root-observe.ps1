$ErrorActionPreference='Stop'
$r=Get-Content 'C:\Users\nicho\backups\hermes-phase2b-20261021\step05\default\gateway-stop.json' -Raw|ConvertFrom-Json
$t=Get-ScheduledTask -TaskName 'Hermes_Gateway';$i=$t|Get-ScheduledTaskInfo
$live=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match 'gateway\s+run' -and $_.CommandLine -notmatch '(?:--profile|-p)\s+[\w-]+'}|ForEach-Object{@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}})
$d=Get-Content 'C:\Users\nicho\AppData\Local\hermes\cron\jobs.json' -Raw|ConvertFrom-Json;$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)}
$now=[datetimeoffset]::Now;$elapsed=($now-[datetimeoffset]::Parse($r.observation_start)).TotalSeconds
$startup=@(Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" -File|Where-Object{$_.Name -match '^Hermes_Gateway\.(?:vbs|cmd|bat)' -and $_.Extension -in '.vbs','.cmd','.bat','.lnk','.exe'})
$checks=@{full15min=($elapsed -ge 900);task_disabled=(-not $t.Settings.Enabled);last_run_unchanged=($i.LastRunTime.ToString('o') -eq $r.last_run);no_root_gateway=($live.Count -eq 0);no_active_root_startup=($startup.Count -eq 0);no_enabled_root_cron=(@($jobs|Where-Object{$_.enabled}).Count -eq 0)}
@{at=$now.ToString('o');profile='default';elapsed_seconds=$elapsed;checks=$checks;gateway_processes=$live}|ConvertTo-Json -Depth 7
