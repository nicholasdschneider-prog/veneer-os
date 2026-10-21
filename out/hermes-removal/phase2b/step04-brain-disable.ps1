$ErrorActionPreference='Stop'
$dir='C:\Users\nicho\backups\hermes-phase2b-20261021\step04';$journal=Join-Path $dir 'brain-disable.json'
if(Test-Path -LiteralPath $journal){throw 'Prior journal exists; reconcile source before any retry'}
$t=Get-ScheduledTask -TaskName 'Hermes_Brain_Backup'
if(-not $t.Settings.Enabled){throw 'Already disabled; inspect source'}
if(@($t.Actions).Count -ne 1 -or $t.Actions[0].Arguments -notmatch 'Hermes_Brain_Backup-silent\.vbs'){throw 'Unexpected task action'}
$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect()
if(@($svc.GetRunningTasks(1)|Where-Object{$_.Name -eq 'Hermes_Brain_Backup'}).Count -gt 0){throw 'Backup in flight; no mutation'}
if(@(Get-CimInstance Win32_Process|Where-Object{[string]$_.CommandLine -match 'Hermes_Brain_Backup-silent\.vbs|Sync-HermesBrain\.ps1'}).Count -gt 0){throw 'Backup process alive; no mutation'}
New-Item -ItemType Directory -Path $dir -Force|Out-Null
$xml=Export-ScheduledTask -TaskName 'Hermes_Brain_Backup';$xmlpath=Join-Path $dir 'Hermes_Brain_Backup-before.xml';[IO.File]::WriteAllText($xmlpath,$xml,(New-Object Text.UTF8Encoding($false)))
$r=@{started_at=(Get-Date).ToUniversalTime().ToString('o');xml_path=$xmlpath;xml_sha256=(Get-FileHash -LiteralPath $xmlpath).Hash;before_enabled=$true;no_inflight=$true;no_job_invoked=$true}
$r|ConvertTo-Json|Set-Content -LiteralPath $journal -Encoding UTF8
Disable-ScheduledTask -TaskName 'Hermes_Brain_Backup'|Out-Null
$t=Get-ScheduledTask -TaskName 'Hermes_Brain_Backup';$i=Get-ScheduledTaskInfo -InputObject $t
$r.disabled_at=(Get-Date).ToUniversalTime().ToString('o');$r.enabled=$t.Settings.Enabled;$r.state=[string]$t.State;$r.last_run=$i.LastRunTime.ToString('o');$r.last_result=$i.LastTaskResult
$r|ConvertTo-Json|Set-Content -LiteralPath $journal -Encoding UTF8
if($t.Settings.Enabled){throw 'Disable readback failed; inspect journal'}
$r|ConvertTo-Json
