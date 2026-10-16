$ErrorActionPreference='Stop'
$stop=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($StopBase64))|ConvertFrom-Json
$name=[string]$stop.profile
$pattern='(?:--profile|-p)\s+'+[regex]::Escape($name)+'(?:\s|$)'
$now=[datetimeoffset]::Now
$start=[datetimeoffset]::Parse($stop.observation_start)
$gateways=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -match $pattern -and $_.CommandLine -match 'gateway\s+run'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}})
$tasks=@($stop.tasks|ForEach-Object {$before=$_;$t=Get-ScheduledTask -TaskName $before.name;$i=$t|Get-ScheduledTaskInfo;@{name=$t.TaskName;enabled=$t.Settings.Enabled;last_run=$i.LastRunTime.ToString('o');last_run_unchanged=($i.LastRunTime.ToString('o') -eq $before.last_run)}})
$launchers=@($stop.launchers|ForEach-Object {$before=$_;$hash=if(Test-Path $before.new){(Get-FileHash $before.new).Hash}else{$null};@{old=$before.old;new=$before.new;active_absent=(-not(Test-Path $before.old));sha256=$hash;sha256_unchanged=($hash -eq $before.sha256)}})
$base=Join-Path 'C:\Users\nicho\AppData\Local\hermes\profiles' $name
$enabled=@();$path=Join-Path $base 'cron\jobs.json'
if(Test-Path $path){$d=Get-Content $path -Raw|ConvertFrom-Json;$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)};$enabled=@($jobs|Where-Object {$_.enabled}|ForEach-Object {$_.id})}
$activeDependencies=@(Get-ScheduledTask|Where-Object {$_.Settings.Enabled -and @($_.Actions|Where-Object {($_.Arguments -match [regex]::Escape($name) -or $_.Execute -match [regex]::Escape($name))}).Count -gt 0}|ForEach-Object {$_.TaskName})
$checks=@{full_15m=(($now-$start).TotalSeconds -ge 900);no_gateway=($gateways.Count -eq 0);all_watchdogs_disabled=(@($tasks|Where-Object {$_.enabled}).Count -eq 0);watchdog_last_runs_unchanged=(@($tasks|Where-Object {-not $_.last_run_unchanged}).Count -eq 0);active_launchers_absent=(@($launchers|Where-Object {-not $_.active_absent}).Count -eq 0);renamed_launcher_hashes_unchanged=(@($launchers|Where-Object {-not $_.sha256_unchanged}).Count -eq 0);no_enabled_cron=($enabled.Count -eq 0);no_enabled_task_dependency=($activeDependencies.Count -eq 0)}
[pscustomobject]@{at=$now.ToString('o');item=9;profile=$name;observation_start=$start.ToString('o');elapsed_seconds=($now-$start).TotalSeconds;checks=$checks;gateways=$gateways;tasks=$tasks;launchers=$launchers;enabled_cron_ids=$enabled;active_task_dependencies=$activeDependencies}|ConvertTo-Json -Depth 9
