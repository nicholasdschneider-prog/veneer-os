$ErrorActionPreference='Stop'
$journal='C:\Users\nicho\backups\hermes-phase2-20261016\dashboard\steps.jsonl'
$steps=if(Test-Path $journal){@(Get-Content $journal|ForEach-Object {$_|ConvertFrom-Json})}else{@()}
$all=@(Get-CimInstance Win32_Process)
$procs=@($all|Where-Object {$_.ProcessId -in 9500,10500,5372,10496 -or ($_.CommandLine -match 'hermes' -and $_.CommandLine -match 'dashboard')}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o');name=$_.Name;is_dashboard=($_.CommandLine -match 'dashboard');executable=$_.ExecutablePath}})
$t=Get-ScheduledTask -TaskName 'ERVP Hermes Dashboard'
[pscustomobject]@{at=(Get-Date -Format o);steps=$steps;processes=$procs;task_enabled=$t.Settings.Enabled;active_task_launcher_exists=(Test-Path 'C:\Users\nicho\AppData\Local\hermes\services\dashboard\dashboard_supervisor.vbs');disabled_task_launcher_exists=(Test-Path 'C:\Users\nicho\AppData\Local\hermes\services\dashboard\dashboard_supervisor.vbs.disabled-20261016')}|ConvertTo-Json -Depth 9
