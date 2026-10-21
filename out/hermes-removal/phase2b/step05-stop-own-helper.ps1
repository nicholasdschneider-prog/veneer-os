$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter 'ProcessId=15004'
if(-not $p){@{already_absent=$true}|ConvertTo-Json;exit}
if($p.Name -ne 'powershell.exe' -or $p.ParentProcessId -ne 6444 -or $p.CreationDate.ToString('o') -ne '2026-10-21T15:50:20.7569780-04:00' -or [string]$p.CommandLine -notmatch '^powershell\s+-NoProfile -NonInteractive -EncodedCommand WwBDAG8AbgBzAG8AbABlAF0AOgA6AE8AdQB0AHAAdQB0'){throw 'Own helper identity mismatch: no stop'}
$j='C:\Users\nicho\backups\hermes-phase2b-20261021\step05\ervp-manager\idle-steps.jsonl'
if(Test-Path $j){throw 'Mutation journal now exists: reconcile first'}
$t=Get-ScheduledTask -TaskName 'Hermes_ERVP_Manager_Watchdog'
$l="$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Hermes_Gateway_ervp-manager.vbs"
if(-not $t.Settings.Enabled -or -not(Test-Path $l) -or (Get-FileHash $l).Hash -ne '6A0ED801EEACEE8B9054F7389E51A1F72908AFC8F779788121D449F2CA92E806'){throw 'Effects changed: no helper stop until reconciled'}
Stop-Process -Id 15004
@{at=(Get-Date).ToUniversalTime().ToString('o');stopped_own_isolated_helper=15004;parent=6444;created=$p.CreationDate.ToString('o');command_sha256=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$p.CommandLine)))).Replace('-','');manager_task_still_enabled=$true;launcher_unchanged=$true;journal_absent=$true;no_business_process_targeted=$true}|ConvertTo-Json
