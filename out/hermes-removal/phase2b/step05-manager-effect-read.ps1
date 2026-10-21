$ErrorActionPreference='Stop'
$j='C:\Users\nicho\backups\hermes-phase2b-20261021\step05\ervp-manager\idle-steps.jsonl'
$lines=if(Test-Path $j){@(Get-Content -LiteralPath $j|ForEach-Object{$_|ConvertFrom-Json})}else{@()}
$t=Get-ScheduledTask -TaskName 'Hermes_ERVP_Manager_Watchdog';$i=$t|Get-ScheduledTaskInfo
@{at=(Get-Date).ToUniversalTime().ToString('o');journal_exists=(Test-Path $j);steps=$lines;task_enabled=$t.Settings.Enabled;task_state=[string]$t.State;last_run=$i.LastRunTime.ToString('o');launchers=@(Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\*ervp-manager*"|ForEach-Object{@{name=$_.Name;sha256=(Get-FileHash $_.FullName).Hash}})}|ConvertTo-Json -Depth 10
