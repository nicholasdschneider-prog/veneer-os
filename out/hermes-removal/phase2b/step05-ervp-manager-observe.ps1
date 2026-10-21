$ErrorActionPreference='Stop'
$r=Get-Content 'C:\Users\nicho\backups\hermes-phase2b-20261021\step05\ervp-manager\manager-disable.json' -Raw|ConvertFrom-Json
$t=Get-ScheduledTask -TaskName 'Hermes_ERVP_Manager_Watchdog';$i=Get-ScheduledTaskInfo -InputObject $t
$pattern='(?:--profile|-p)\s+ervp-manager(?:\s|$)'
$live=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match $pattern -and $_.CommandLine -match 'gateway\s+run'}|ForEach-Object{@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}})
$d=Get-Content 'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-manager\cron\jobs.json' -Raw|ConvertFrom-Json
$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)}
$now=[datetimeoffset]::Now;$elapsed=($now-[datetimeoffset]::Parse($r.observation_start)).TotalSeconds
$hash=if(Test-Path $r.launcher.new){(Get-FileHash $r.launcher.new).Hash}else{$null}
$checks=@{full15min=($elapsed -ge 900);disabled=(-not $t.Settings.Enabled);last_run_unchanged=($i.LastRunTime.ToString('o') -eq $r.last_run);no_profile_gateway=($live.Count -eq 0);active_startup_absent=(-not(Test-Path $r.launcher.old));renamed_hash_same=($hash -eq $r.launcher.sha256);no_enabled_cron=(@($jobs|Where-Object{$_.enabled}).Count -eq 0)}
@{at=$now.ToString('o');profile='ervp-manager';elapsed_seconds=$elapsed;checks=$checks;gateway_processes=$live;shared_root_not_targeted=$true}|ConvertTo-Json -Depth 7
