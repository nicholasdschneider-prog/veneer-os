$ErrorActionPreference='Stop'
$dir='C:\Users\nicho\backups\hermes-phase2b-20261021\step03'
$journal=Join-Path $dir 'task-disable.json'
if(Test-Path -LiteralPath $journal){throw 'Journal exists: read it and current source, never repeat disables blindly'}
$names=@('ERVP_Orders_Bot_Direct_Shopify','ERVP_Orders_Bot_All_Order_Review')
$pattern='ERVP_Orders_Bot_(?:Direct_Shopify|All_Order_Review)|production_owner_policy_cycle|run_production_owner_policy_cycle|run_every_order_review|every_order_review|all_order_review'
function Processes {
 $all=@(Get-CimInstance Win32_Process)
 $ids=@($all|Where-Object{[string]$_.CommandLine -match $pattern}|ForEach-Object{[uint32]$_.ProcessId})
 do {$old=$ids.Count;$ids=@($ids+@($all|Where-Object{$ids -contains [uint32]$_.ParentProcessId}|ForEach-Object{[uint32]$_.ProcessId})|Select-Object -Unique)}while($ids.Count -gt $old)
 @($all|Where-Object{$ids -contains [uint32]$_.ProcessId}|ForEach-Object{@{pid=$_.ProcessId;parent_pid=$_.ParentProcessId;created=$_.CreationDate.ToString('o');name=$_.Name;executable=$_.ExecutablePath;matched_source=([string]$_.CommandLine -match $pattern)}})
}
$tasks=@()
foreach($n in $names){
 $t=Get-ScheduledTask -TaskName $n
 if(-not $t.Settings.Enabled){throw ('Task already disabled; reconcile prior effect: '+$n)}
 if(@($t.Actions).Count -ne 1 -or $t.Actions[0].Execute -notmatch '(?i)wscript\.exe$' -or $t.Actions[0].Arguments -notmatch ([regex]::Escape($n+'-silent.vbs'))){throw 'Task action differs from reviewed exact launcher'}
 $xml=Export-ScheduledTask -TaskName $n
 $tasks+=@{name=$n;before_state=[string]$t.State;before_enabled=$t.Settings.Enabled;xml_sha256=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-','').ToLowerInvariant()}
}
New-Item -ItemType Directory -Path $dir -Force|Out-Null
$r=@{started_at=(Get-Date).ToUniversalTime().ToString('o');tasks=$tasks;before_process_tree=@(Processes);effects=@();no_process_stop=$true}
$r|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $journal -Encoding UTF8
foreach($n in $names){
 Disable-ScheduledTask -TaskName $n|Out-Null
 $t=Get-ScheduledTask -TaskName $n;$i=Get-ScheduledTaskInfo -InputObject $t
 $r.effects+=@{name=$n;disabled_at=(Get-Date).ToUniversalTime().ToString('o');enabled=$t.Settings.Enabled;state=[string]$t.State;last_run=$i.LastRunTime.ToString('o');last_result=$i.LastTaskResult}
 $r|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $journal -Encoding UTF8
 if($t.Settings.Enabled){throw 'Disable did not stick; inspect journal'}
}
$r.after_process_tree=@(Processes);$r.finished_at=(Get-Date).ToUniversalTime().ToString('o')
$r|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $journal -Encoding UTF8
$r|ConvertTo-Json -Depth 10
