$ErrorActionPreference='Stop'
$dir='C:\Users\nicho\backups\hermes-phase2b-20261021\step05\desktop-update';$j=Join-Path $dir 'disable.json';$name='HermesDesktopUpdate-20260805'
if(Test-Path $j){throw 'Prior journal: inspect before retry'}
$t=Get-ScheduledTask -TaskName $name;$i=$t|Get-ScheduledTaskInfo
if(-not $t.Settings.Enabled -or [string]$t.State -ne 'Ready' -or $t.Actions[0].Arguments -notmatch 'run-desktop-update-20260805\.py'){throw 'Unexpected task state/action'}
$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect()
if(@($svc.GetRunningTasks(1)|Where-Object{$_.Name -eq $name}).Count){throw 'Task instance in flight'}
if(@(Get-CimInstance Win32_Process|Where-Object{[string]$_.CommandLine -match 'run-desktop-update-20260805\.py'}).Count){throw 'Updater process in flight'}
[IO.Directory]::CreateDirectory($dir)|Out-Null
$path=Join-Path $dir 'task-before.xml';[IO.File]::WriteAllText($path,(Export-ScheduledTask -TaskName $name),(New-Object Text.UTF8Encoding($false)))
$script='C:\Users\nicho\AppData\Local\hermes\update-backups\run-desktop-update-20260805.py'
$r=@{name=$name;started_at=(Get-Date).ToUniversalTime().ToString('o');xml_path=$path;xml_sha256=(Get-FileHash $path).Hash;script=$script;script_sha256=(Get-FileHash $script).Hash;last_run=$i.LastRunTime.ToString('o');last_result=$i.LastTaskResult;no_inflight=$true;no_job_invoked=$true}
$r|ConvertTo-Json|Set-Content $j -Encoding UTF8
Disable-ScheduledTask -TaskName $name|Out-Null
$r.disabled_at=(Get-Date).ToUniversalTime().ToString('o');$r.enabled=(Get-ScheduledTask -TaskName $name).Settings.Enabled
$r|ConvertTo-Json|Set-Content $j -Encoding UTF8
if($r.enabled){throw 'Disable readback failed'}
$r|ConvertTo-Json
