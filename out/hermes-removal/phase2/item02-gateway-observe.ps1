$ErrorActionPreference='Stop'
$stop=[datetimeoffset]::Parse('2026-10-16T08:51:55.9298884-04:00')
$now=[datetimeoffset]::Now
$t=Get-ScheduledTask -TaskName 'Hermes_CS_Tim_Watchdog'
$i=$t|Get-ScheduledTaskInfo
$p=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -match '(?:--profile|-p)\s+cs-tim(?:\s|$)' -and $_.CommandLine -match 'gateway\s+run'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o');name=$_.Name}})
$old="$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Hermes_Gateway_cs-tim.vbs"
$new=$old+'.disabled-20261016'
$hash=if(Test-Path -LiteralPath $new){(Get-FileHash -LiteralPath $new).Hash}else{$null}
$checks=@{window_complete=(($now-$stop).TotalSeconds -ge 900);watchdog_disabled=(-not $t.Settings.Enabled);watchdog_last_run_unchanged=($i.LastRunTime.ToString('o') -eq '2026-10-16T08:51:43.0000000-04:00');no_gateway=($p.Count -eq 0);active_launcher_absent=(-not (Test-Path -LiteralPath $old));renamed_launcher_hash_unchanged=($hash -eq '41A00EE6C553B611D9EAD5A093A54B54EF6FEC14B9AC2EB581C096EA9E85CAD4')}
[pscustomobject]@{item=2;at=$now.ToString('o');stopped_at=$stop.ToString('o');observation_seconds=($now-$stop).TotalSeconds;checks=$checks;matching_gateways=$p;task_last_run=$i.LastRunTime.ToString('o');task_last_result=$i.LastTaskResult;launcher=$new;launcher_sha256=$hash}|ConvertTo-Json -Depth 7
