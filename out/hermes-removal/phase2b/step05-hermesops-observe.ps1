$ErrorActionPreference='Stop'
$r=Get-Content 'C:\Users\nicho\backups\hermes-phase2b-20261021\step05\hermesops\gateway-stop.json' -Raw|ConvertFrom-Json
$t=Get-ScheduledTask -TaskName 'Hermes_HermesOps_Watchdog';$i=$t|Get-ScheduledTaskInfo
$pattern='(?:--profile|-p)\s+hermesops(?:\s|$)'
$live=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match $pattern -and $_.CommandLine -match 'gateway\s+run'}|ForEach-Object{@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}})
$d=Get-Content 'C:\Users\nicho\AppData\Local\hermes\profiles\hermesops\cron\jobs.json' -Raw|ConvertFrom-Json;$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)}
$now=[datetimeoffset]::Now;$elapsed=($now-[datetimeoffset]::Parse($r.observation_start)).TotalSeconds
$historical="$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Hermes_Gateway_hermesops.vbs.disabled-20260724-111603"
$active=@(Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" -File|Where-Object{$_.Name -match 'hermesops' -and $_.Extension -in '.vbs','.cmd','.bat','.lnk','.exe'})
$checks=@{full15min=($elapsed -ge 900);disabled=(-not $t.Settings.Enabled);last_run_unchanged=($i.LastRunTime.ToString('o') -eq $r.last_run);no_profile_gateway=($live.Count -eq 0);no_active_startup=($active.Count -eq 0);historical_hash_same=((Get-FileHash $historical).Hash -eq 'FF557BD8EF35DC35D99E6BC250588E5B7DE6B86B13A97FA28862950E1FBB1FAD');no_enabled_cron=(@($jobs|Where-Object{$_.enabled}).Count -eq 0)}
@{at=$now.ToString('o');profile='hermesops';elapsed_seconds=$elapsed;checks=$checks;gateway_processes=$live}|ConvertTo-Json -Depth 7
