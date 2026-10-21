$ErrorActionPreference='Stop'
$dir='C:\Users\nicho\backups\hermes-phase2b-20261021\step05\ervp-manager';$j=Join-Path $dir 'manager-disable.json'
if((Test-Path $j) -or (Test-Path (Join-Path $dir 'idle-steps.jsonl'))){throw 'Existing mutation journal: reconcile before retry'}
if(Get-CimInstance Win32_Process -Filter 'ProcessId=15004'){throw 'Previous own helper not absent'}
$pattern='(?:--profile|-p)\s+ervp-manager(?:\s|$)'
if(@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match $pattern -and $_.CommandLine -match 'gateway\s+run'}).Count){throw 'Profile gateway appeared: fresh identity review required'}
$base='C:\Users\nicho\AppData\Local\hermes\profiles\ervp-manager'
$d=Get-Content "$base\cron\jobs.json" -Raw|ConvertFrom-Json
if(@($d.jobs|Where-Object{$_.enabled}).Count){throw 'Enabled cron remains'}
$t=Get-ScheduledTask -TaskName 'Hermes_ERVP_Manager_Watchdog';$i=Get-ScheduledTaskInfo -InputObject $t
if(-not $t.Settings.Enabled -or [string]$t.State -ne 'Ready'){throw 'Task state changed'}
$l="$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Hermes_Gateway_ervp-manager.vbs";$dest=$l+'.disabled-20261021'
if((Test-Path $dest) -or (Get-FileHash $l).Hash -ne '6A0ED801EEACEE8B9054F7389E51A1F72908AFC8F779788121D449F2CA92E806'){throw 'Launcher changed'}
[IO.Directory]::CreateDirectory($dir)|Out-Null
$xml=Export-ScheduledTask -TaskName $t.TaskName;[IO.File]::WriteAllText((Join-Path $dir 'watchdog-before.xml'),$xml,(New-Object Text.UTF8Encoding($false)))
$r=@{profile='ervp-manager';started_at=(Get-Date).ToUniversalTime().ToString('o');last_run=$i.LastRunTime.ToString('o');process_stops=@();manager_profile_gateway_absent=$true;shared_root_preserved=$true;xml_sha256=(Get-FileHash (Join-Path $dir 'watchdog-before.xml')).Hash}
$r|ConvertTo-Json -Depth 6|Set-Content $j -Encoding UTF8
Disable-ScheduledTask -TaskName $t.TaskName|Out-Null
$r.task_disabled_at=(Get-Date).ToUniversalTime().ToString('o');$r.task_enabled=(Get-ScheduledTask -TaskName $t.TaskName).Settings.Enabled
$r|ConvertTo-Json -Depth 6|Set-Content $j -Encoding UTF8
if($r.task_enabled){throw 'Disable readback failed'}
Rename-Item -LiteralPath $l -NewName ((Split-Path $l -Leaf)+'.disabled-20261021')
$r.launcher=@{old=$l;new=$dest;sha256=(Get-FileHash $dest).Hash};$r.observation_start=(Get-Date).ToUniversalTime().ToString('o')
$r|ConvertTo-Json -Depth 6|Set-Content $j -Encoding UTF8
$r|ConvertTo-Json -Depth 6
